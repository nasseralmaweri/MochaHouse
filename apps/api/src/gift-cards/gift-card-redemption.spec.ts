import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { FakePaymentProvider } from '@mocha-house/integrations';
import type { CheckoutRequest } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { LocationsModule } from '../locations/locations.module';
import { CustomersModule } from '../customers/customers.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { CheckoutService } from '../orders/application/checkout.service';
import { PAYMENT_PROVIDER } from '../orders/infrastructure/payment-provider.token';
import { PaymentModule } from '../payment/payment.module';
import { GiftCardsModule } from './gift-cards.module';
import { GiftCardRedemptionService } from './application/gift-card-redemption.service';
import {
  canonicalizeGiftCardCode,
  generateGiftCardCode,
  hashGiftCardCode,
} from './infrastructure/gift-card-code';

// Milestone 7G — gift-card redemption at checkout, exercised through the
// real CheckoutService orchestration against the real local Postgres (like
// checkout.service.spec.ts). Requires the seeded dearborn-heights /
// drip-coffee fixture. A single drip coffee, Medium = 400 minor units.
describe('Gift card redemption at checkout (integration)', () => {
  let prisma: PrismaService;
  let checkoutService: CheckoutService;
  let redemptionService: GiftCardRedemptionService;
  let paymentProvider: FakePaymentProvider;
  let locationId: string;
  let productId: string;
  let sizeGroupId: string;
  let mediumOptionId: string;
  const originalEnv = { ...process.env };
  const giftCardIds: string[] = [];

  beforeAll(async () => {
    process.env.GIFT_CARD_CODE_SECRET = 'gift-card-redemption-spec-secret';

    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        LocationsModule,
        CustomersModule,
        CustomerAuthModule,
        InternalAuthModule,
        LoyaltyModule,
        PromotionsModule,
        GiftCardsModule,
        PaymentModule,
      ],
      providers: [CheckoutService],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    checkoutService = moduleRef.get(CheckoutService);
    redemptionService = moduleRef.get(GiftCardRedemptionService);
    paymentProvider = moduleRef.get(PAYMENT_PROVIDER);
    await prisma.$connect();

    const location = await prisma.location.findUniqueOrThrow({
      where: { slug: 'dearborn-heights' },
    });
    const product = await prisma.product.findUniqueOrThrow({
      where: { slug: 'drip-coffee' },
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
      where: { idempotencyKey: { startsWith: 'gcr_' } },
      select: { id: true },
    });
    const attemptIds = attempts.map((a) => a.id);
    if (attemptIds.length > 0) {
      const orders = await prisma.order.findMany({
        where: { paymentAttemptId: { in: attemptIds } },
        select: { id: true },
      });
      const orderIds = orders.map((o) => o.id);
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
      await prisma.paymentAttempt.deleteMany({
        where: { id: { in: attemptIds } },
      });
    }

    if (giftCardIds.length > 0) {
      await prisma.giftCardTransaction.deleteMany({
        where: { giftCardId: { in: giftCardIds } },
      });
      await prisma.giftCard.deleteMany({ where: { id: { in: giftCardIds } } });
    }

    const customers = await prisma.customer.findMany({
      where: {
        externalProvider: 'test',
        externalSubject: { startsWith: 'test-customer-gcr-' },
      },
      select: { id: true },
    });
    const customerIds = customers.map((c) => c.id);
    await prisma.customerLoyaltyAccount.deleteMany({
      where: { customerId: { in: customerIds } },
    });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });

    await prisma.$disconnect();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildRequest(
    overrides: Partial<CheckoutRequest> = {},
  ): CheckoutRequest {
    return {
      idempotencyKey: `gcr_${randomUUID()}`,
      locationId,
      guest: { name: 'GC Guest', phone: '5551234567' },
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

  // Creates a real gift card (a GiftCard row + its ISSUANCE ledger entry)
  // with a known plaintext code. Returns the display code the customer would
  // type.
  async function createGiftCard(
    balanceMinorUnits: number,
    opts: { status?: 'ACTIVE' | 'INACTIVE'; currency?: string } = {},
  ): Promise<{ id: string; code: string; last4: string }> {
    const code = generateGiftCardCode();
    const canonical = canonicalizeGiftCardCode(code)!;
    const last4 = canonical.slice(-4);
    const card = await prisma.giftCard.create({
      data: {
        codeHash: hashGiftCardCode(canonical),
        last4,
        status: opts.status ?? 'ACTIVE',
        originalValueMinorUnits: balanceMinorUnits,
        balanceMinorUnits,
        currency: opts.currency ?? 'USD',
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
    return { id: card.id, code, last4 };
  }

  async function ledgerSum(giftCardId: string): Promise<number> {
    const rows = await prisma.giftCardTransaction.findMany({
      where: { giftCardId },
      select: { amountMinorUnits: true },
    });
    return rows.reduce((total, row) => total + row.amountMinorUnits, 0);
  }

  async function reloadCard(giftCardId: string) {
    return prisma.giftCard.findUniqueOrThrow({ where: { id: giftCardId } });
  }

  // --- FULL GIFT-CARD PAYMENT --------------------------------------

  it('a gift card covering the full total: no external charge, redemption recorded, ledger == balance', async () => {
    const gc = await createGiftCard(1000); // covers the 400 total
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');

    const confirmation = await checkoutService.checkout(
      buildRequest({ giftCardCode: gc.code }),
    );

    expect(chargeSpy).not.toHaveBeenCalled();
    expect(confirmation.subtotal).toBe(400);
    expect(confirmation.total).toBe(400);
    expect(confirmation.giftCardTenderMinorUnits).toBe(400);
    expect(confirmation.externalPaymentMinorUnits).toBe(0);
    expect(confirmation.orderGiftCard).toEqual({
      last4: gc.last4,
      amountMinorUnits: 400,
    });

    const attempt = await prisma.paymentAttempt.findFirstOrThrow({
      where: { order: { id: confirmation.orderId } },
    });
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.amount).toBe(0);
    expect(attempt.providerReference).toBe('no-charge');

    const redemption = await prisma.orderGiftCardRedemption.findUniqueOrThrow({
      where: { orderId: confirmation.orderId },
    });
    expect(redemption.amountMinorUnits).toBe(400);
    expect(redemption.last4).toBe(gc.last4);

    const txns = await prisma.giftCardTransaction.findMany({
      where: { giftCardId: gc.id, type: 'REDEMPTION' },
    });
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({
      amountMinorUnits: -400,
      balanceAfterMinorUnits: 600,
      orderId: confirmation.orderId,
    });

    const card = await reloadCard(gc.id);
    expect(card.balanceMinorUnits).toBe(600);
    expect(await ledgerSum(gc.id)).toBe(600);
  });

  // --- SPLIT TENDER -----------------------------------------------

  it('a gift card smaller than the total: split tender, external charge for the remainder', async () => {
    const gc = await createGiftCard(150); // total 400 -> external 250
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');

    const confirmation = await checkoutService.checkout(
      buildRequest({ giftCardCode: gc.code }),
    );

    expect(chargeSpy).toHaveBeenCalledTimes(1);
    expect(chargeSpy.mock.calls[0][0].amount).toBe(250);
    expect(confirmation.giftCardTenderMinorUnits).toBe(150);
    expect(confirmation.externalPaymentMinorUnits).toBe(250);
    expect(confirmation.orderGiftCard).toEqual({
      last4: gc.last4,
      amountMinorUnits: 150,
    });

    const attempt = await prisma.paymentAttempt.findFirstOrThrow({
      where: { order: { id: confirmation.orderId } },
    });
    expect(attempt.amount).toBe(250);

    const card = await reloadCard(gc.id);
    expect(card.balanceMinorUnits).toBe(0);
    expect(await ledgerSum(gc.id)).toBe(0);
  });

  // --- GIFT CARD + PROMOTION + REWARD ----------------------------

  it('gift card stacks with a coupon and a Mocha Bean reward — tender is not part of the earning basis', async () => {
    // A 25%-off ENTIRE_ORDER coupon + a $1.00 FIXED_AMOUNT reward.
    const couponCode = `GC7G${Math.floor(Math.random() * 1e6)}`;
    const promotion = await prisma.promotion.create({
      data: {
        name: 'GCR coupon',
        kind: 'COUPON',
        code: couponCode,
        discountType: 'PERCENTAGE_OFF',
        discountValue: 25,
        appliesToAllLocations: true,
      },
    });
    const reward = await prisma.loyaltyReward.create({
      data: {
        name: 'GCR $1 off',
        type: 'FIXED_AMOUNT',
        beanCost: 5,
        fixedAmountMinorUnits: 100,
      },
    });

    const identity = {
      provider: 'test' as const,
      subject: `test-customer-gcr-${randomUUID()}`,
      email: 'gcr@example.com',
      name: null,
      emailVerified: null,
    };
    // Give the customer Beans up front.
    const customer = await prisma.customer.create({
      data: {
        externalProvider: identity.provider,
        externalSubject: identity.subject,
        email: identity.email,
      },
    });
    await prisma.customerLoyaltyAccount.create({
      data: { customerId: customer.id, balance: 100 },
    });

    const gc = await createGiftCard(10_000);

    try {
      // subtotal 400 -> -25% coupon (100) -> 300 -> -$1 reward (100) -> owed 200.
      const confirmation = await checkoutService.checkout(
        buildRequest({
          giftCardCode: gc.code,
          couponCode,
          loyaltyRewardId: reward.id,
        }),
        identity,
      );

      expect(confirmation.subtotal).toBe(400);
      expect(confirmation.promotionDiscount).toBe(100);
      expect(confirmation.rewardDiscount).toBe(100);
      expect(confirmation.total).toBe(200); // owed
      expect(confirmation.giftCardTenderMinorUnits).toBe(200);
      expect(confirmation.externalPaymentMinorUnits).toBe(0);

      // Earning basis is the post-DISCOUNT merchandise (200), NOT reduced by
      // the gift-card tender: $2 qualifying * 1 Bean/$ = 2 Beans EARNED, and
      // 5 Beans REDEEMED for the reward -> net balance 100 - 5 + 2 = 97.
      const account = await prisma.customerLoyaltyAccount.findUniqueOrThrow({
        where: { customerId: customer.id },
      });
      expect(account.balance).toBe(97);

      const card = await reloadCard(gc.id);
      expect(card.balanceMinorUnits).toBe(9_800);
      expect(await ledgerSum(gc.id)).toBe(9_800);
    } finally {
      await prisma.promotion.deleteMany({ where: { id: promotion.id } });
      await prisma.loyaltyReward.deleteMany({ where: { id: reward.id } });
    }
  });

  // --- DUPLICATE / IDEMPOTENCY -----------------------------------

  it('a duplicate submission with the same idempotencyKey never decrements the card twice', async () => {
    const gc = await createGiftCard(1000);
    const request = buildRequest({ giftCardCode: gc.code });

    const first = await checkoutService.checkout(request);
    const second = await checkoutService.checkout(request);

    expect(second.orderId).toBe(first.orderId);

    const txns = await prisma.giftCardTransaction.count({
      where: { giftCardId: gc.id, type: 'REDEMPTION' },
    });
    expect(txns).toBe(1);
    const card = await reloadCard(gc.id);
    expect(card.balanceMinorUnits).toBe(600);
    expect(await ledgerSum(gc.id)).toBe(600);
  });

  it('a retry after a lost response returns the existing order without a second decrement', async () => {
    const gc = await createGiftCard(1000);
    const request = buildRequest({ giftCardCode: gc.code });
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');

    await checkoutService.checkout(request);
    // Simulate the client never seeing the response and retrying.
    const retry = await checkoutService.checkout(request);
    expect(retry.giftCardTenderMinorUnits).toBe(400);

    expect(chargeSpy).not.toHaveBeenCalled(); // full gift-card cover
    const card = await reloadCard(gc.id);
    expect(card.balanceMinorUnits).toBe(600);
    const redemptions = await prisma.orderGiftCardRedemption.count({
      where: { sourceGiftCardId: gc.id },
    });
    expect(redemptions).toBe(1);
  });

  // --- CONCURRENT REDEMPTION -----------------------------------

  it('two concurrent checkouts against one card never overspend it', async () => {
    const gc = await createGiftCard(500); // enough for exactly one 400 order
    const results = await Promise.allSettled([
      checkoutService.checkout(buildRequest({ giftCardCode: gc.code })),
      checkoutService.checkout(buildRequest({ giftCardCode: gc.code })),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    // Exactly one order can be fully paid by this card; the other either
    // fell back to a split tender (150 remained) or was flagged for
    // reconciliation. In no case is the card overspent.
    const card = await reloadCard(gc.id);
    expect(card.balanceMinorUnits).toBeGreaterThanOrEqual(0);
    expect(await ledgerSum(gc.id)).toBe(card.balanceMinorUnits);

    const redemptionRows = await prisma.giftCardTransaction.findMany({
      where: { giftCardId: gc.id, type: 'REDEMPTION' },
    });
    const totalRedeemed = redemptionRows.reduce(
      (t, r) => t + Math.abs(r.amountMinorUnits),
      0,
    );
    expect(totalRedeemed).toBeLessThanOrEqual(500);
    expect(card.balanceMinorUnits).toBe(500 - totalRedeemed);
    // Every persisted order's tender matches a REDEMPTION row.
    for (const r of fulfilled) {
      if (r.status !== 'fulfilled') continue;
      const order = r.value;
      const row = redemptionRows.find((x) => x.orderId === order.orderId);
      if (order.giftCardTenderMinorUnits > 0) {
        expect(row).toBeDefined();
        expect(Math.abs(row!.amountMinorUnits)).toBe(
          order.giftCardTenderMinorUnits,
        );
      }
    }
  });

  // --- REJECTIONS (pre-payment) --------------------------------

  it('an inactive card is rejected before any payment or order', async () => {
    const gc = await createGiftCard(1000, { status: 'INACTIVE' });
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    await expect(
      checkoutService.checkout(buildRequest({ giftCardCode: gc.code })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(chargeSpy).not.toHaveBeenCalled();
    const card = await reloadCard(gc.id);
    expect(card.balanceMinorUnits).toBe(1000);
    const orders = await prisma.orderGiftCardRedemption.count({
      where: { sourceGiftCardId: gc.id },
    });
    expect(orders).toBe(0);
  });

  it('a zero-balance card is rejected with a clear message', async () => {
    const gc = await createGiftCard(0);
    await expect(
      checkoutService.checkout(buildRequest({ giftCardCode: gc.code })),
    ).rejects.toThrow(/no available balance/i);
  });

  it('an unknown code is rejected before any payment', async () => {
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    await expect(
      checkoutService.checkout(
        buildRequest({ giftCardCode: 'ZZZZ ZZZZ ZZZZ ZZZZ' }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(chargeSpy).not.toHaveBeenCalled();
  });

  it('a currency mismatch is hard-rejected', async () => {
    const gc = await createGiftCard(1000, { currency: 'EUR' });
    await expect(
      checkoutService.checkout(buildRequest({ giftCardCode: gc.code })),
    ).rejects.toThrow(/currency/i);
    const card = await reloadCard(gc.id);
    expect(card.balanceMinorUnits).toBe(1000);
  });

  // --- EXTERNAL PAYMENT FAILURE PATHS --------------------------

  it('a declined external payment leaves the gift card untouched', async () => {
    const gc = await createGiftCard(150); // split tender: 250 external
    await expect(
      checkoutService.checkout(
        buildRequest({
          giftCardCode: gc.code,
          guest: { name: 'GC Guest', phone: FakePaymentProvider.DECLINE_TEST_PHONE },
        }),
      ),
    ).rejects.toThrow();

    const card = await reloadCard(gc.id);
    expect(card.balanceMinorUnits).toBe(150);
    expect(await ledgerSum(gc.id)).toBe(150);
    const redemptions = await prisma.orderGiftCardRedemption.count({
      where: { sourceGiftCardId: gc.id },
    });
    expect(redemptions).toBe(0);
  });

  it('a technically failed external payment leaves the gift card untouched', async () => {
    const gc = await createGiftCard(150);
    jest
      .spyOn(paymentProvider, 'charge')
      .mockResolvedValueOnce({ outcome: 'failed', reason: 'Gateway timeout' });

    await expect(
      checkoutService.checkout(buildRequest({ giftCardCode: gc.code })),
    ).rejects.toThrow();

    const card = await reloadCard(gc.id);
    expect(card.balanceMinorUnits).toBe(150);
    const redemptions = await prisma.orderGiftCardRedemption.count({
      where: { sourceGiftCardId: gc.id },
    });
    expect(redemptions).toBe(0);
  });

  // --- LOCAL TRANSACTION FAILURE + RECONCILIATION --------------

  it('external payment succeeds but the order transaction fails: card unchanged, no redemption rows, reconciliationRequired', async () => {
    const gc = await createGiftCard(150); // split tender -> 250 external charge
    const request = buildRequest({ giftCardCode: gc.code });
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    jest
      .spyOn(prisma, '$transaction')
      .mockRejectedValueOnce(new Error('Simulated Order transaction failure'));

    await expect(checkoutService.checkout(request)).rejects.toThrow(
      'Simulated Order transaction failure',
    );

    const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { idempotencyKey: request.idempotencyKey },
    });
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.reconciliationRequired).toBe(true);
    expect(attempt.amount).toBe(250);
    expect(chargeSpy).toHaveBeenCalledTimes(1);

    const card = await reloadCard(gc.id);
    expect(card.balanceMinorUnits).toBe(150);
    expect(await ledgerSum(gc.id)).toBe(150);
    const redemptions = await prisma.orderGiftCardRedemption.count({
      where: { sourceGiftCardId: gc.id },
    });
    expect(redemptions).toBe(0);
    const redemptionTxns = await prisma.giftCardTransaction.count({
      where: { giftCardId: gc.id, type: 'REDEMPTION' },
    });
    expect(redemptionTxns).toBe(0);

    // Retry recognizes the reconciliation condition — no second charge, no
    // decrement.
    await expect(checkoutService.checkout(request)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(chargeSpy).toHaveBeenCalledTimes(1);
    expect((await reloadCard(gc.id)).balanceMinorUnits).toBe(150);
  });

  // --- BALANCE CHANGES BETWEEN PLANNING AND LOCKED APPLY -------

  it('the card is corrected below the planned tender mid-flight: rollback + reconciliationRequired, planned tender never reduced', async () => {
    const gc = await createGiftCard(1000); // plans a 400 tender (full cover)
    const request = buildRequest({ giftCardCode: gc.code });

    // Between the pre-payment plan and the locked apply, drop the balance
    // below the planned tender (an HQ correction / concurrent redemption).
    const realTransaction = prisma.$transaction.bind(prisma);
    jest
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce(async (arg: unknown) => {
        await prisma.giftCard.update({
          where: { id: gc.id },
          data: { balanceMinorUnits: 100 },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (realTransaction as any)(arg);
      });

    await expect(checkoutService.checkout(request)).rejects.toBeInstanceOf(
      ConflictException,
    );

    const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { idempotencyKey: request.idempotencyKey },
    });
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.reconciliationRequired).toBe(true);

    // The order transaction rolled back — the injected balance drop to 100
    // stands, but NO redemption was recorded and the planned 400 was never
    // partially applied.
    const card = await reloadCard(gc.id);
    expect(card.balanceMinorUnits).toBe(100);
    const redemptions = await prisma.orderGiftCardRedemption.count({
      where: { sourceGiftCardId: gc.id },
    });
    expect(redemptions).toBe(0);
    expect(await ledgerSum(gc.id)).toBe(1000); // only the ISSUANCE entry
  });

  // --- QUOTE IS READ-ONLY ------------------------------------

  it('the checkout quote resolves the card read-only and reserves / decrements nothing', async () => {
    const gc = await createGiftCard(300); // less than the 400 total

    const quote = await checkoutService.quoteCheckout(
      {
        locationId,
        lines: [
          {
            productId,
            quantity: 1,
            selections: [{ groupId: sizeGroupId, optionIds: [mediumOptionId] }],
          },
        ],
        giftCardCode: gc.code,
      },
      undefined,
    );

    expect(quote.giftCardStatus).toBe('applied');
    expect(quote.giftCard).toEqual({
      last4: gc.last4,
      availableBalanceMinorUnits: 300,
      appliedMinorUnits: 300,
    });
    expect(quote.total).toBe(400);
    expect(quote.amountDueAfterGiftCardMinorUnits).toBe(100);

    // Nothing changed.
    const card = await reloadCard(gc.id);
    expect(card.balanceMinorUnits).toBe(300);
    const txns = await prisma.giftCardTransaction.count({
      where: { giftCardId: gc.id },
    });
    expect(txns).toBe(1); // just the ISSUANCE entry

    // resolveUsableCard on its own also mutates nothing.
    await redemptionService.resolveUsableCard(gc.code, 'USD');
    expect((await reloadCard(gc.id)).balanceMinorUnits).toBe(300);
  });

  it('the quote reports a non-usable card without applying it', async () => {
    const inactive = await createGiftCard(500, { status: 'INACTIVE' });
    const quote = await checkoutService.quoteCheckout(
      {
        locationId,
        lines: [
          {
            productId,
            quantity: 1,
            selections: [{ groupId: sizeGroupId, optionIds: [mediumOptionId] }],
          },
        ],
        giftCardCode: inactive.code,
      },
      undefined,
    );
    expect(quote.giftCardStatus).toBe('inactive');
    expect(quote.giftCard).toBeNull();
    expect(quote.amountDueAfterGiftCardMinorUnits).toBe(quote.total);
  });

  // --- PLAINTEXT-CODE NON-EXPOSURE ---------------------------

  it('never exposes the plaintext gift-card code in the order, snapshot, ledger, outbox or responses', async () => {
    const gc = await createGiftCard(1000);
    const canonical = canonicalizeGiftCardCode(gc.code)!;

    const confirmation = await checkoutService.checkout(
      buildRequest({ giftCardCode: gc.code }),
    );
    expect(JSON.stringify(confirmation)).not.toContain(canonical);

    const status = await checkoutService.getStatus(
      confirmation.orderId,
      confirmation.accessToken,
    );
    expect(JSON.stringify(status)).not.toContain(canonical);

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: confirmation.orderId },
    });
    expect(JSON.stringify(order)).not.toContain(canonical);

    const redemption = await prisma.orderGiftCardRedemption.findUniqueOrThrow({
      where: { orderId: confirmation.orderId },
    });
    expect(JSON.stringify(redemption)).not.toContain(canonical);
    // The only code representation is last4.
    expect(redemption.last4).toBe(gc.last4);

    const txn = await prisma.giftCardTransaction.findFirstOrThrow({
      where: { orderId: confirmation.orderId, type: 'REDEMPTION' },
    });
    expect(JSON.stringify(txn)).not.toContain(canonical);

    const outbox = await prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateType: 'Order', aggregateId: confirmation.orderId },
    });
    expect(JSON.stringify(outbox)).not.toContain(canonical);
    expect(JSON.stringify(outbox)).not.toContain(gc.last4);
  });

  // --- ONE REDEMPTION PER ORDER ----------------------------

  it('enforces one REDEMPTION per order at the database level', async () => {
    const gc = await createGiftCard(1000);
    const confirmation = await checkoutService.checkout(
      buildRequest({ giftCardCode: gc.code }),
    );
    // A direct second REDEMPTION row for the same order is impossible.
    await expect(
      prisma.giftCardTransaction.create({
        data: {
          giftCardId: gc.id,
          type: 'REDEMPTION',
          amountMinorUnits: -1,
          balanceAfterMinorUnits: 0,
          orderId: confirmation.orderId,
        },
      }),
    ).rejects.toThrow();
  });

  // --- EXISTING EXTERNAL-PAYMENT-ONLY CHECKOUT UNCHANGED ----

  it('a checkout with no gift card is completely unchanged (no redemption, external charge for the full total)', async () => {
    const chargeSpy = jest.spyOn(paymentProvider, 'charge');
    const confirmation = await checkoutService.checkout(buildRequest());

    expect(chargeSpy).toHaveBeenCalledTimes(1);
    expect(chargeSpy.mock.calls[0][0].amount).toBe(400);
    expect(confirmation.giftCardTenderMinorUnits).toBe(0);
    expect(confirmation.externalPaymentMinorUnits).toBe(400);
    expect(confirmation.orderGiftCard).toBeNull();

    const redemption = await prisma.orderGiftCardRedemption.findUnique({
      where: { orderId: confirmation.orderId },
    });
    expect(redemption).toBeNull();
  });
});
