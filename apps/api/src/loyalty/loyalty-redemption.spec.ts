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
import { CheckoutService } from '../orders/application/checkout.service';
import { PAYMENT_PROVIDER } from '../orders/infrastructure/payment-provider.token';
import type { CustomerIdentity } from '../customer-auth/infrastructure/customer-identity';
import { LoyaltyModule } from './loyalty.module';

// Milestone 7C — Mocha Bean reward redemption at checkout, exercised through
// the real CheckoutService against local Postgres. A dedicated test
// location + menu with three priced products in two categories gives full
// control over FIXED_AMOUNT and FREE_ITEM eligibility.
describe('Mocha Bean reward redemption at checkout (integration)', () => {
  let prisma: PrismaService;
  let checkoutService: CheckoutService;
  let paymentProvider: FakePaymentProvider;

  const suffix = randomUUID();
  const KEY_PREFIX = 'test_redeem_';
  const SUBJECT_PREFIX = 'test-redeem-';

  let locationId: string;
  let drinksCategoryId: string;
  let foodCategoryId: string;
  let latteId: string; // drinks, $5.00
  let pastryId: string; // food, $3.00
  let muffinId: string; // food, $4.00
  const rewardIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        LocationsModule,
        CustomersModule,
        CustomerAuthModule,
        InternalAuthModule,
        LoyaltyModule,
      ],
      providers: [
        CheckoutService,
        { provide: PAYMENT_PROVIDER, useClass: FakePaymentProvider },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    checkoutService = moduleRef.get(CheckoutService);
    paymentProvider = moduleRef.get(PAYMENT_PROVIDER);
    await prisma.$connect();

    // Pin the earning rate to 1 (the settings suite mutates the shared row).
    await prisma.loyaltyConfiguration.upsert({
      where: { key: 'company' },
      update: { earningRatePerDollar: 1 },
      create: { key: 'company', earningRatePerDollar: 1 },
    });

    const location = await prisma.location.create({
      data: {
        name: `Redeem Spec Loc ${suffix}`,
        slug: `redeem-spec-${suffix}`,
        isActive: true,
        isDigitalOrderingEnabled: true,
      },
    });
    locationId = location.id;

    const drinks = await prisma.category.create({
      data: { name: `Redeem Drinks ${suffix}`, slug: `redeem-drinks-${suffix}` },
    });
    const food = await prisma.category.create({
      data: { name: `Redeem Food ${suffix}`, slug: `redeem-food-${suffix}` },
    });
    drinksCategoryId = drinks.id;
    foodCategoryId = food.id;

    const mk = (name: string, slug: string, price: number, categoryId: string) =>
      prisma.product.create({
        data: {
          name,
          slug: `${slug}-${suffix}`,
          basePrice: price,
          currency: 'USD',
          categoryId,
        },
      });
    latteId = (await mk('Redeem Latte', 'redeem-latte', 500, drinksCategoryId)).id;
    pastryId = (await mk('Redeem Pastry', 'redeem-pastry', 300, foodCategoryId)).id;
    muffinId = (await mk('Redeem Muffin', 'redeem-muffin', 400, foodCategoryId)).id;

    const menu = await prisma.menu.create({
      data: { name: `Redeem Menu ${suffix}`, slug: `redeem-menu-${suffix}` },
    });
    await prisma.menuProduct.createMany({
      data: [latteId, pastryId, muffinId].map((productId, i) => ({
        menuId: menu.id,
        productId,
        displayOrder: i,
        isActive: true,
      })),
    });
    await prisma.locationMenu.create({
      data: { locationId, menuId: menu.id, isActive: true },
    });
  });

  afterEach(async () => {
    if (rewardIds.length > 0) {
      await prisma.loyaltyRewardProduct.deleteMany({
        where: { rewardId: { in: rewardIds } },
      });
      await prisma.loyaltyRewardCategory.deleteMany({
        where: { rewardId: { in: rewardIds } },
      });
    }
  });

  afterAll(async () => {
    // Customers -> cascades CustomerLoyaltyAccount + all ledger entries.
    await prisma.customer.deleteMany({
      where: {
        externalProvider: 'test',
        externalSubject: { startsWith: SUBJECT_PREFIX },
      },
    });

    const attempts = await prisma.paymentAttempt.findMany({
      where: { idempotencyKey: { startsWith: KEY_PREFIX } },
      select: { id: true },
    });
    const attemptIds = attempts.map((a) => a.id);
    if (attemptIds.length > 0) {
      const orders = await prisma.order.findMany({
        where: { paymentAttemptId: { in: attemptIds } },
        select: { id: true },
      });
      const orderIds = orders.map((o) => o.id);
      await prisma.mochaBeanLedgerEntry.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await prisma.orderLoyaltyRewardRedemption.deleteMany({
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

    await prisma.loyaltyReward.deleteMany({ where: { id: { in: rewardIds } } });
    await prisma.menuProduct.deleteMany({
      where: { productId: { in: [latteId, pastryId, muffinId] } },
    });
    await prisma.locationMenu.deleteMany({ where: { locationId } });
    await prisma.menu.deleteMany({ where: { slug: `redeem-menu-${suffix}` } });
    await prisma.product.deleteMany({
      where: { id: { in: [latteId, pastryId, muffinId] } },
    });
    await prisma.category.deleteMany({
      where: { id: { in: [drinksCategoryId, foodCategoryId] } },
    });
    await prisma.location.deleteMany({ where: { id: locationId } });
    await prisma.$disconnect();
  });

  // --- helpers -----------------------------------------------------

  function identity(s: string): CustomerIdentity {
    return {
      provider: 'test',
      subject: `${SUBJECT_PREFIX}${s}`,
      email: `${s}@example.com`,
      name: null,
      emailVerified: null,
    };
  }

  async function customerIdFor(id: CustomerIdentity): Promise<string> {
    const customer = await prisma.customer.findUniqueOrThrow({
      where: {
        externalProvider_externalSubject: {
          externalProvider: id.provider,
          externalSubject: id.subject,
        },
      },
    });
    return customer.id;
  }

  async function grantBeans(id: CustomerIdentity, amount: number): Promise<void> {
    // Provision the customer + account by resolving identity through a
    // throwaway checkout is heavy; create directly.
    const customer = await prisma.customer.upsert({
      where: {
        externalProvider_externalSubject: {
          externalProvider: id.provider,
          externalSubject: id.subject,
        },
      },
      update: {},
      create: {
        externalProvider: id.provider,
        externalSubject: id.subject,
        email: id.email,
      },
    });
    await prisma.customerLoyaltyAccount.upsert({
      where: { customerId: customer.id },
      update: { balance: amount },
      create: { customerId: customer.id, balance: amount },
    });
  }

  async function balanceOf(customerId: string): Promise<number> {
    const account = await prisma.customerLoyaltyAccount.findUnique({
      where: { customerId },
      select: { balance: true },
    });
    return account?.balance ?? 0;
  }

  async function ledgerFor(customerId: string) {
    const account = await prisma.customerLoyaltyAccount.findUnique({
      where: { customerId },
      select: { id: true },
    });
    if (!account) return [];
    return prisma.mochaBeanLedgerEntry.findMany({
      where: { loyaltyAccountId: account.id },
      orderBy: { createdAt: 'asc' },
    });
  }

  async function makeFixedReward(
    beanCost: number,
    fixedAmountMinorUnits: number,
  ): Promise<string> {
    const reward = await prisma.loyaltyReward.create({
      data: {
        name: `$${(fixedAmountMinorUnits / 100).toFixed(2)} Off ${randomUUID()}`,
        type: 'FIXED_AMOUNT',
        beanCost,
        fixedAmountMinorUnits,
      },
    });
    rewardIds.push(reward.id);
    return reward.id;
  }

  async function makeFreeItemReward(
    beanCost: number,
    opts: { productIds?: string[]; categoryIds?: string[] },
  ): Promise<string> {
    const reward = await prisma.loyaltyReward.create({
      data: {
        name: `Free Item ${randomUUID()}`,
        type: 'FREE_ITEM',
        beanCost,
        eligibleProducts: opts.productIds
          ? { create: opts.productIds.map((productId) => ({ productId })) }
          : undefined,
        eligibleCategories: opts.categoryIds
          ? { create: opts.categoryIds.map((categoryId) => ({ categoryId })) }
          : undefined,
      },
    });
    rewardIds.push(reward.id);
    return reward.id;
  }

  function req(
    lines: CheckoutRequest['lines'],
    over: Partial<CheckoutRequest> = {},
  ): CheckoutRequest {
    return {
      idempotencyKey: `${KEY_PREFIX}${randomUUID()}`,
      locationId,
      guest: { name: 'Redeem Guest', phone: '5551234567' },
      lines,
      ...over,
    };
  }

  const line = (productId: string, quantity = 1) => ({
    productId,
    quantity,
    selections: [],
  });

  afterEach(() => jest.restoreAllMocks());

  // --- FIXED_AMOUNT ---------------------------------------------

  it('applies a fixed dollar-off reward: discount, full bean cost, earning on net', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 100);
    const customerId = await customerIdFor(id);
    const rewardId = await makeFixedReward(100, 500); // $5 off, 100 Beans

    // Cart: 1 latte ($5) + 1 muffin ($4) = $9.00 gross
    const confirmation = await checkoutService.checkout(
      req([line(latteId), line(muffinId)], { loyaltyRewardId: rewardId }),
      id,
    );

    expect(confirmation.subtotal).toBe(900);
    expect(confirmation.rewardDiscount).toBe(500);
    expect(confirmation.total).toBe(400);
    expect(confirmation.loyaltyReward).toMatchObject({
      rewardType: 'FIXED_AMOUNT',
      beanCost: 100,
      discountMinorUnits: 500,
    });

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: confirmation.orderId },
      include: { paymentAttempt: true, loyaltyRewardRedemption: true },
    });
    expect(order.rewardDiscountMinorUnits).toBe(500);
    expect(order.paymentAttempt.amount).toBe(400); // charged the net
    expect(order.loyaltyRewardRedemption?.sourceRewardId).toBe(rewardId);

    const ledger = await ledgerFor(customerId);
    const redeem = ledger.find((e) => e.type === 'REDEEM')!;
    const earn = ledger.find((e) => e.type === 'EARN')!;
    expect(redeem.amount).toBe(-100);
    expect(redeem.orderId).toBe(confirmation.orderId);
    // Earned on net $4.00 -> 4 Beans
    expect(earn.amount).toBe(4);
    expect(earn.orderId).toBe(confirmation.orderId);
    // 100 - 100 + 4
    expect(await balanceOf(customerId)).toBe(4);
  });

  it('caps the discount at the merchandise subtotal but still deducts the full bean cost', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 100);
    const customerId = await customerIdFor(id);
    const rewardId = await makeFixedReward(100, 500); // $5 off

    // Cart: 1 pastry ($3.00) — reward value ($5) exceeds it.
    const confirmation = await checkoutService.checkout(
      req([line(pastryId)], { loyaltyRewardId: rewardId }),
      id,
    );

    expect(confirmation.subtotal).toBe(300);
    expect(confirmation.rewardDiscount).toBe(300); // capped at $3.00
    expect(confirmation.total).toBe(0);

    const order = await prisma.order.findUniqueOrThrow({
      where: { id: confirmation.orderId },
      include: { paymentAttempt: true },
    });
    expect(order.paymentAttempt.status).toBe('SUCCEEDED');
    expect(order.paymentAttempt.amount).toBe(0);

    const ledger = await ledgerFor(customerId);
    expect(ledger.find((e) => e.type === 'REDEEM')!.amount).toBe(-100); // full cost
    // net $0 -> earn 0
    expect(ledger.find((e) => e.type === 'EARN')).toBeUndefined();
    expect(await balanceOf(customerId)).toBe(0);
  });

  // --- FREE_ITEM ------------------------------------------------

  it('free-item reward: eligible by product, frees that unit', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 200);
    const customerId = await customerIdFor(id);
    const rewardId = await makeFreeItemReward(150, { productIds: [latteId] });

    const confirmation = await checkoutService.checkout(
      req([line(latteId), line(pastryId)], { loyaltyRewardId: rewardId }),
      id,
    );
    // gross $5 + $3 = $8; free latte -$5 => net $3
    expect(confirmation.subtotal).toBe(800);
    expect(confirmation.rewardDiscount).toBe(500);
    expect(confirmation.total).toBe(300);
    expect(confirmation.loyaltyReward?.freeItemName).toBe('Redeem Latte');

    const redemption = await prisma.orderLoyaltyRewardRedemption.findUniqueOrThrow(
      { where: { orderId: confirmation.orderId } },
    );
    expect(redemption.freeItemProductId).toBe(latteId);
    expect(redemption.freeItemProductName).toBe('Redeem Latte');

    // earn on net $3 -> 3 Beans; balance 200 - 150 + 3
    expect(await balanceOf(customerId)).toBe(53);
  });

  it('free-item reward: eligible by category, frees the LOWEST-priced eligible unit', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 200);
    const rewardId = await makeFreeItemReward(150, {
      categoryIds: [foodCategoryId],
    });

    // Cart: pastry ($3, food), muffin ($4, food), latte ($5, drinks).
    // Eligible food items: pastry & muffin -> free the cheaper (pastry $3).
    const confirmation = await checkoutService.checkout(
      req([line(pastryId), line(muffinId), line(latteId)], {
        loyaltyRewardId: rewardId,
      }),
      id,
    );
    expect(confirmation.rewardDiscount).toBe(300);
    expect(confirmation.loyaltyReward?.freeItemName).toBe('Redeem Pastry');
  });

  it('free-item reward: quantity > 1 frees only ONE unit', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 200);
    const rewardId = await makeFreeItemReward(150, { productIds: [muffinId] });

    // 3 muffins @ $4 = $12 gross; one free -> $8 net
    const confirmation = await checkoutService.checkout(
      req([line(muffinId, 3)], { loyaltyRewardId: rewardId }),
      id,
    );
    expect(confirmation.subtotal).toBe(1200);
    expect(confirmation.rewardDiscount).toBe(400); // one unit, not the line
    expect(confirmation.total).toBe(800);
  });

  it('free-item reward: rejected before payment when no cart item is eligible', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 200);
    const customerId = await customerIdFor(id);
    const rewardId = await makeFreeItemReward(150, { productIds: [latteId] });

    const request = req([line(pastryId)], { loyaltyRewardId: rewardId });
    await expect(checkoutService.checkout(request, id)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // No payment attempt, no order, no deduction.
    const attempt = await prisma.paymentAttempt.findUnique({
      where: { idempotencyKey: request.idempotencyKey },
    });
    expect(attempt).toBeNull();
    expect(await balanceOf(customerId)).toBe(200);
  });

  // --- AUTH ----------------------------------------------------

  it('a guest cannot redeem a reward (rejected before payment, no auto-match)', async () => {
    const rewardId = await makeFixedReward(50, 200);
    const request = req([line(latteId)], { loyaltyRewardId: rewardId });

    await expect(
      checkoutService.checkout(request, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);

    const attempt = await prisma.paymentAttempt.findUnique({
      where: { idempotencyKey: request.idempotencyKey },
    });
    expect(attempt).toBeNull();
  });

  // --- STATE -------------------------------------------------

  it('rejects an inactive reward before payment', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 200);
    const rewardId = await makeFixedReward(50, 200);
    await prisma.loyaltyReward.update({
      where: { id: rewardId },
      data: { isActive: false },
    });

    await expect(
      checkoutService.checkout(
        req([line(latteId)], { loyaltyRewardId: rewardId }),
        id,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects insufficient Beans before payment', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 40);
    const customerId = await customerIdFor(id);
    const rewardId = await makeFixedReward(100, 300);

    const request = req([line(latteId)], { loyaltyRewardId: rewardId });
    await expect(checkoutService.checkout(request, id)).rejects.toBeInstanceOf(
      ConflictException,
    );
    const attempt = await prisma.paymentAttempt.findUnique({
      where: { idempotencyKey: request.idempotencyKey },
    });
    expect(attempt).toBeNull();
    expect(await balanceOf(customerId)).toBe(40);
  });

  it('rejects an unknown reward id before payment', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 200);
    await expect(
      checkoutService.checkout(
        req([line(latteId)], { loyaltyRewardId: randomUUID() }),
        id,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // --- IDEMPOTENCY ------------------------------------------

  it('checkout replay does not deduct, earn, or snapshot twice', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 200);
    const customerId = await customerIdFor(id);
    const rewardId = await makeFixedReward(100, 500);
    const request = req([line(latteId), line(muffinId)], {
      loyaltyRewardId: rewardId,
    });

    const first = await checkoutService.checkout(request, id);
    const second = await checkoutService.checkout(request, id);
    expect(second.orderId).toBe(first.orderId);

    const ledger = await ledgerFor(customerId);
    expect(ledger.filter((e) => e.type === 'REDEEM')).toHaveLength(1);
    expect(ledger.filter((e) => e.type === 'EARN')).toHaveLength(1);
    const redemptions = await prisma.orderLoyaltyRewardRedemption.findMany({
      where: { orderId: first.orderId },
    });
    expect(redemptions).toHaveLength(1);
    // 200 - 100 + earn(net $4 => 4)
    expect(await balanceOf(customerId)).toBe(104);
  });

  // --- CONCURRENCY -----------------------------------------

  it('two concurrent orders spending the same Beans: exactly one redeems', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 100);
    const customerId = await customerIdFor(id);
    const rewardId = await makeFixedReward(100, 300);

    const results = await Promise.allSettled([
      checkoutService.checkout(
        req([line(latteId)], { loyaltyRewardId: rewardId }),
        id,
      ),
      checkoutService.checkout(
        req([line(latteId)], { loyaltyRewardId: rewardId }),
        id,
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const ledger = await ledgerFor(customerId);
    expect(ledger.filter((e) => e.type === 'REDEEM')).toHaveLength(1);
    const balance = await balanceOf(customerId);
    expect(balance).toBeGreaterThanOrEqual(0); // never negative

    // The loser's payment was captured but flagged for reconciliation.
    const reconciled = await prisma.paymentAttempt.findMany({
      where: {
        idempotencyKey: { startsWith: KEY_PREFIX },
        reconciliationRequired: true,
      },
    });
    expect(reconciled.length).toBeGreaterThanOrEqual(1);
  });

  // --- PAYMENT SAFETY ---------------------------------------

  it('a declined payment redeems nothing and deducts nothing', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 200);
    const customerId = await customerIdFor(id);
    const rewardId = await makeFixedReward(100, 200);

    await expect(
      checkoutService.checkout(
        req([line(latteId)], {
          loyaltyRewardId: rewardId,
          guest: {
            name: 'Declined',
            phone: FakePaymentProvider.DECLINE_TEST_PHONE,
          },
        }),
        id,
      ),
    ).rejects.toBeDefined();

    expect(await balanceOf(customerId)).toBe(200);
    expect(
      (await ledgerFor(customerId)).filter((e) => e.type === 'REDEEM'),
    ).toHaveLength(0);
  });

  it('failure inside the order transaction after payment: SUCCEEDED + reconciliationRequired, nothing persisted', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 200);
    const customerId = await customerIdFor(id);
    const rewardId = await makeFixedReward(100, 500);
    const request = req([line(latteId), line(muffinId)], {
      loyaltyRewardId: rewardId,
    });

    jest
      .spyOn(prisma, '$transaction')
      .mockRejectedValueOnce(new Error('Simulated order transaction failure'));

    await expect(checkoutService.checkout(request, id)).rejects.toThrow(
      'Simulated order transaction failure',
    );

    const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { idempotencyKey: request.idempotencyKey },
    });
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.reconciliationRequired).toBe(true);
    expect(attempt.amount).toBe(400); // charged the net

    const order = await prisma.order.findUnique({
      where: { paymentAttemptId: attempt.id },
    });
    expect(order).toBeNull();
    expect(await balanceOf(customerId)).toBe(200); // untouched
    expect(
      (await ledgerFor(customerId)).filter((e) => e.type === 'REDEEM'),
    ).toHaveLength(0);
  });

  // --- HISTORY --------------------------------------------

  it('editing or deactivating the reward after the order never changes the snapshot', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 300);
    const rewardId = await makeFixedReward(100, 500);

    const confirmation = await checkoutService.checkout(
      req([line(latteId), line(muffinId)], { loyaltyRewardId: rewardId }),
      id,
    );
    const before = await prisma.orderLoyaltyRewardRedemption.findUniqueOrThrow({
      where: { orderId: confirmation.orderId },
    });

    await prisma.loyaltyReward.update({
      where: { id: rewardId },
      data: {
        name: 'Renamed reward',
        beanCost: 999,
        fixedAmountMinorUnits: 1,
        isActive: false,
      },
    });

    const after = await prisma.orderLoyaltyRewardRedemption.findUniqueOrThrow({
      where: { orderId: confirmation.orderId },
    });
    expect(after.rewardName).toBe(before.rewardName);
    expect(after.beanCost).toBe(before.beanCost);
    expect(after.discountMinorUnits).toBe(before.discountMinorUnits);

    // And the order status read still shows the historical values.
    const status = await checkoutService.getStatus(
      confirmation.orderId,
      confirmation.accessToken,
    );
    expect(status.loyaltyReward?.rewardName).toBe(before.rewardName);
    expect(status.rewardDiscount).toBe(500);
  });

  // --- ACCOUNTING ----------------------------------------

  it('respects the configured earning rate after the reward discount', async () => {
    await prisma.loyaltyConfiguration.update({
      where: { key: 'company' },
      data: { earningRatePerDollar: 2 },
    });
    try {
      const id = identity(randomUUID());
      await grantBeans(id, 300);
      const customerId = await customerIdFor(id);
      const rewardId = await makeFixedReward(100, 500);

      // gross $9, -$5 => net $4 => 4 whole dollars * rate 2 = 8 Beans
      await checkoutService.checkout(
        req([line(latteId), line(muffinId)], { loyaltyRewardId: rewardId }),
        id,
      );
      const ledger = await ledgerFor(customerId);
      expect(ledger.find((e) => e.type === 'EARN')!.amount).toBe(8);
      expect(await balanceOf(customerId)).toBe(300 - 100 + 8);
    } finally {
      await prisma.loyaltyConfiguration.update({
        where: { key: 'company' },
        data: { earningRatePerDollar: 1 },
      });
    }
  });

  it('an order without a reward is completely unaffected', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 100);
    const customerId = await customerIdFor(id);

    const confirmation = await checkoutService.checkout(
      req([line(latteId)]),
      id,
    );
    expect(confirmation.rewardDiscount).toBe(0);
    expect(confirmation.total).toBe(confirmation.subtotal);
    expect(confirmation.loyaltyReward).toBeNull();

    const ledger = await ledgerFor(customerId);
    expect(ledger.filter((e) => e.type === 'REDEEM')).toHaveLength(0);
    expect(ledger.find((e) => e.type === 'EARN')!.amount).toBe(5); // $5 -> 5
    expect(await balanceOf(customerId)).toBe(105);
  });
});
