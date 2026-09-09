import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { FakePaymentProvider } from '@mocha-house/integrations';
import type { CheckoutRequest } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { LocationsModule } from '../locations/locations.module';
import { CustomersModule } from '../customers/customers.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { CheckoutService } from '../orders/application/checkout.service';
import { PaymentModule } from '../payment/payment.module';
import type { CustomerIdentity } from '../customer-auth/infrastructure/customer-identity';
import { PromotionsModule } from './promotions.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';

// Milestone 7E — Promotions & Coupons at checkout, exercised end-to-end
// through the real CheckoutService against local Postgres.
describe('Promotions & Coupons at checkout (integration)', () => {
  let prisma: PrismaService;
  let checkoutService: CheckoutService;

  const suffix = randomUUID();
  const KEY_PREFIX = 'test_promo_';
  const SUBJECT_PREFIX = 'test-promo-';

  let locationId: string;
  let otherLocationId: string;
  let drinksCategoryId: string;
  let foodCategoryId: string;
  let latteId: string; // drinks, $5.00
  let pastryId: string; // food, $3.00
  let muffinId: string; // food, $4.00
  let sizeGroupId: string;
  let sizeSmallId: string; // +$0
  let sizeLargeId: string; // +$2.00 -> a Large latte is $7.00
  const promotionIds: string[] = [];

  beforeAll(async () => {
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
    await prisma.$connect();

    await prisma.loyaltyConfiguration.upsert({
      where: { key: 'company' },
      update: { earningRatePerDollar: 1 },
      create: { key: 'company', earningRatePerDollar: 1 },
    });

    const mkLoc = (n: string) =>
      prisma.location.create({
        data: {
          name: `Promo Chk ${n} ${suffix}`,
          slug: `promo-chk-${n}-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      });
    locationId = (await mkLoc('a')).id;
    otherLocationId = (await mkLoc('b')).id;

    drinksCategoryId = (
      await prisma.category.create({
        data: { name: `PC Drinks ${suffix}`, slug: `pc-drinks-${suffix}` },
      })
    ).id;
    foodCategoryId = (
      await prisma.category.create({
        data: { name: `PC Food ${suffix}`, slug: `pc-food-${suffix}` },
      })
    ).id;

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
    latteId = (await mk('PC Latte', 'pc-latte', 500, drinksCategoryId)).id;
    pastryId = (await mk('PC Pastry', 'pc-pastry', 300, foodCategoryId)).id;
    muffinId = (await mk('PC Muffin', 'pc-muffin', 400, foodCategoryId)).id;

    // A size modifier on the latte so the SAME product can appear on two
    // priced lines with different modifier-inclusive unit prices.
    const sizeGroup = await prisma.modifierGroup.create({
      data: {
        name: `PC Size ${suffix}`,
        displayOrder: 1,
        // Optional so existing `line(latteId)` cases (no selection) keep the
        // $5.00 base price; an explicit Large selection makes it $7.00.
        isRequired: false,
        minSelections: 0,
        maxSelections: 1,
        isActive: true,
      },
    });
    sizeGroupId = sizeGroup.id;
    await prisma.productModifierGroup.create({
      data: { productId: latteId, modifierGroupId: sizeGroup.id, displayOrder: 1 },
    });
    sizeSmallId = (
      await prisma.modifierOption.create({
        data: {
          name: 'Small',
          priceAdjustment: 0,
          displayOrder: 1,
          isActive: true,
          modifierGroupId: sizeGroup.id,
        },
      })
    ).id;
    sizeLargeId = (
      await prisma.modifierOption.create({
        data: {
          name: 'Large',
          priceAdjustment: 200,
          displayOrder: 2,
          isActive: true,
          modifierGroupId: sizeGroup.id,
        },
      })
    ).id;

    const menu = await prisma.menu.create({
      data: { name: `PC Menu ${suffix}`, slug: `pc-menu-${suffix}` },
    });
    await prisma.menuProduct.createMany({
      data: [latteId, pastryId, muffinId].map((productId, i) => ({
        menuId: menu.id,
        productId,
        displayOrder: i,
        isActive: true,
      })),
    });
    await prisma.locationMenu.createMany({
      data: [locationId, otherLocationId].map((locId) => ({
        locationId: locId,
        menuId: menu.id,
        isActive: true,
      })),
    });
  });

  afterEach(async () => {
    // Every test starts from a clean promotion table — a leaked ENTIRE_ORDER
    // automatic promotion would silently discount the next test's cart.
    if (promotionIds.length > 0) {
      await prisma.promotionProduct.deleteMany({
        where: { promotionId: { in: promotionIds } },
      });
      await prisma.promotionCategory.deleteMany({
        where: { promotionId: { in: promotionIds } },
      });
      await prisma.promotionLocation.deleteMany({
        where: { promotionId: { in: promotionIds } },
      });
      await prisma.promotionCustomerUsage.deleteMany({
        where: { promotionId: { in: promotionIds } },
      });
      await prisma.orderPromotionRedemption.deleteMany({
        where: { sourcePromotionId: { in: promotionIds } },
      });
      await prisma.promotion.deleteMany({ where: { id: { in: promotionIds } } });
      promotionIds.length = 0;
    }
    await prisma.loyaltyBonusPromotion.deleteMany({
      where: { name: { contains: suffix } },
    });
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await prisma.orderPromotionRedemption.deleteMany({
      where: { sourcePromotionId: { in: promotionIds } },
    });
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
      await prisma.orderLoyaltyBonusItem.deleteMany({
        where: { orderLoyaltyBonus: { orderId: { in: orderIds } } },
      });
      await prisma.orderLoyaltyBonus.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await prisma.orderPromotionRedemption.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await prisma.orderLoyaltyRewardRedemption.deleteMany({
        where: { orderId: { in: orderIds } },
      });
      await prisma.mochaBeanLedgerEntry.deleteMany({
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
    await prisma.promotionCustomerUsage.deleteMany({
      where: { promotionId: { in: promotionIds } },
    });
    await prisma.promotion.deleteMany({ where: { id: { in: promotionIds } } });
    await prisma.loyaltyReward.deleteMany({
      where: { name: { contains: suffix } },
    });
    await prisma.menuProduct.deleteMany({
      where: { productId: { in: [latteId, pastryId, muffinId] } },
    });
    await prisma.locationMenu.deleteMany({
      where: { locationId: { in: [locationId, otherLocationId] } },
    });
    await prisma.menu.deleteMany({ where: { slug: `pc-menu-${suffix}` } });
    await prisma.productModifierGroup.deleteMany({
      where: { modifierGroupId: sizeGroupId },
    });
    await prisma.modifierOption.deleteMany({
      where: { modifierGroupId: sizeGroupId },
    });
    await prisma.product.deleteMany({
      where: { id: { in: [latteId, pastryId, muffinId] } },
    });
    await prisma.modifierGroup.deleteMany({ where: { id: sizeGroupId } });
    await prisma.category.deleteMany({
      where: { id: { in: [drinksCategoryId, foodCategoryId] } },
    });
    await prisma.location.deleteMany({
      where: { id: { in: [locationId, otherLocationId] } },
    });
    await prisma.$disconnect();
  });

  // --- helpers -----------------------------------------------

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

  async function makePromotion(opts: {
    kind: 'AUTOMATIC' | 'COUPON';
    code?: string;
    discountType: 'PERCENTAGE_OFF' | 'FIXED_AMOUNT' | 'FREE_ITEM';
    discountValue?: number;
    maxDiscountMinorUnits?: number | null;
    applicability?: 'ENTIRE_ORDER' | 'SELECTED_PRODUCTS' | 'SELECTED_CATEGORIES';
    productIds?: string[];
    categoryIds?: string[];
    minimumSubtotalMinorUnits?: number | null;
    isActive?: boolean;
    startsAt?: Date | null;
    endsAt?: Date | null;
    appliesToAllLocations?: boolean;
    locationIds?: string[];
    totalRedemptionLimit?: number | null;
    perCustomerRedemptionLimit?: number | null;
  }): Promise<string> {
    const promotion = await prisma.promotion.create({
      data: {
        name: `${opts.kind} ${opts.discountType} ${randomUUID()} ${suffix}`,
        kind: opts.kind,
        code: opts.code ?? null,
        discountType: opts.discountType,
        discountValue: opts.discountValue ?? 0,
        maxDiscountMinorUnits: opts.maxDiscountMinorUnits ?? null,
        applicability: opts.applicability ?? 'ENTIRE_ORDER',
        minimumSubtotalMinorUnits: opts.minimumSubtotalMinorUnits ?? null,
        isActive: opts.isActive ?? true,
        startsAt: opts.startsAt ?? null,
        endsAt: opts.endsAt ?? null,
        appliesToAllLocations: opts.appliesToAllLocations ?? true,
        totalRedemptionLimit: opts.totalRedemptionLimit ?? null,
        perCustomerRedemptionLimit: opts.perCustomerRedemptionLimit ?? null,
        eligibleProducts: opts.productIds
          ? { create: opts.productIds.map((productId) => ({ productId })) }
          : undefined,
        eligibleCategories: opts.categoryIds
          ? { create: opts.categoryIds.map((categoryId) => ({ categoryId })) }
          : undefined,
        eligibleLocations: opts.locationIds
          ? { create: opts.locationIds.map((locId) => ({ locationId: locId })) }
          : undefined,
      },
    });
    promotionIds.push(promotion.id);
    return promotion.id;
  }

  async function makeFixedReward(
    beanCost: number,
    fixedAmountMinorUnits: number,
  ): Promise<string> {
    const reward = await prisma.loyaltyReward.create({
      data: {
        name: `Fixed Reward ${randomUUID()} ${suffix}`,
        type: 'FIXED_AMOUNT',
        beanCost,
        fixedAmountMinorUnits,
      },
    });
    return reward.id;
  }

  async function makeFreeItemReward(
    beanCost: number,
    productIds: string[],
  ): Promise<string> {
    const reward = await prisma.loyaltyReward.create({
      data: {
        name: `Free Reward ${randomUUID()} ${suffix}`,
        type: 'FREE_ITEM',
        beanCost,
        eligibleProducts: { create: productIds.map((productId) => ({ productId })) },
      },
    });
    return reward.id;
  }

  function req(
    lines: CheckoutRequest['lines'],
    over: Partial<CheckoutRequest> = {},
  ): CheckoutRequest {
    return {
      idempotencyKey: `${KEY_PREFIX}${randomUUID()}`,
      locationId,
      guest: { name: 'Promo Guest', phone: '5551234567' },
      lines,
      ...over,
    };
  }

  const line = (productId: string, quantity = 1) => ({
    productId,
    quantity,
    selections: [],
  });

  async function orderFor(orderId: string) {
    return prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { paymentAttempt: true, promotionRedemption: true },
    });
  }

  // --- PERCENTAGE / FIXED / FREE_ITEM ---------------------------

  it('an automatic PERCENTAGE_OFF promotion discounts the order and the charge matches', async () => {
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'PERCENTAGE_OFF',
      discountValue: 20,
    });
    const confirmation = await checkoutService.checkout(
      req([line(latteId), line(muffinId)]), // $9
      undefined,
    );
    expect(confirmation.subtotal).toBe(900);
    expect(confirmation.promotionDiscount).toBe(180); // 20% of $9
    expect(confirmation.total).toBe(720);
    const order = await orderFor(confirmation.orderId);
    expect(order.paymentAttempt.amount).toBe(720);
    expect(order.promotionRedemption?.promotionKind).toBe('AUTOMATIC');
  });

  it('a FIXED_AMOUNT promotion is capped at the merchandise amount', async () => {
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'FIXED_AMOUNT',
      discountValue: 500,
    });
    const confirmation = await checkoutService.checkout(
      req([line(pastryId)]), // $3
      undefined,
    );
    expect(confirmation.promotionDiscount).toBe(300);
    expect(confirmation.total).toBe(0);
    const order = await orderFor(confirmation.orderId);
    expect(order.paymentAttempt.status).toBe('SUCCEEDED');
    expect(order.paymentAttempt.amount).toBe(0);
  });

  it('a FREE_ITEM promotion frees the lowest-priced eligible unit', async () => {
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'FREE_ITEM',
      applicability: 'SELECTED_CATEGORIES',
      categoryIds: [foodCategoryId],
    });
    const confirmation = await checkoutService.checkout(
      req([line(pastryId), line(muffinId), line(latteId)]), // food: $3, $4
      undefined,
    );
    expect(confirmation.promotionDiscount).toBe(300); // pastry
    expect(confirmation.orderPromotion?.freeItemName).toBe('PC Pastry');
  });

  // --- COUPON --------------------------------------------------

  it('a coupon code is case-insensitive', async () => {
    await makePromotion({
      kind: 'COUPON',
      code: 'SAVE5NOW',
      discountType: 'FIXED_AMOUNT',
      discountValue: 500,
    });
    const confirmation = await checkoutService.checkout(
      req([line(latteId), line(muffinId)], { couponCode: '  save5now ' }),
      undefined,
    );
    expect(confirmation.promotionDiscount).toBe(500);
    expect(confirmation.orderPromotion?.couponCode).toBe('SAVE5NOW');
  });

  it('an unknown / invalid coupon is rejected before payment', async () => {
    const request = req([line(latteId)], { couponCode: 'NOPENOPE' });
    await expect(
      checkoutService.checkout(request, undefined),
    ).rejects.toBeInstanceOf(BadRequestException);
    const attempt = await prisma.paymentAttempt.findUnique({
      where: { idempotencyKey: request.idempotencyKey },
    });
    expect(attempt).toBeNull();
  });

  it('a valid coupon takes the regular-discount slot over an automatic promotion', async () => {
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'PERCENTAGE_OFF',
      discountValue: 50, // would be $4.50 on a $9 order
    });
    await makePromotion({
      kind: 'COUPON',
      code: 'SMALL1',
      discountType: 'FIXED_AMOUNT',
      discountValue: 100,
    });
    const confirmation = await checkoutService.checkout(
      req([line(latteId), line(muffinId)], { couponCode: 'SMALL1' }),
      undefined,
    );
    // The coupon ($1), not the automatic promotion ($4.50).
    expect(confirmation.promotionDiscount).toBe(100);
    expect(confirmation.orderPromotion?.kind).toBe('COUPON');
  });

  it('an invalid coupon does not silently fall back to an automatic promotion', async () => {
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'PERCENTAGE_OFF',
      discountValue: 20,
    });
    await expect(
      checkoutService.checkout(
        req([line(latteId)], { couponCode: 'WRONGCODE' }),
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('a coupon whose minimum is not met is rejected', async () => {
    await makePromotion({
      kind: 'COUPON',
      code: 'BIG20',
      discountType: 'FIXED_AMOUNT',
      discountValue: 200,
      minimumSubtotalMinorUnits: 2000,
    });
    await expect(
      checkoutService.checkout(
        req([line(latteId)], { couponCode: 'BIG20' }), // $5 < $20
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // --- AUTOMATIC BEST SELECTION ------------------------------

  it('applies the automatic promotion with the highest monetary discount', async () => {
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'FIXED_AMOUNT',
      discountValue: 100,
    });
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'PERCENTAGE_OFF',
      discountValue: 30, // $2.70 on $9
    });
    const confirmation = await checkoutService.checkout(
      req([line(latteId), line(muffinId)]),
      undefined,
    );
    expect(confirmation.promotionDiscount).toBe(270);
  });

  // --- LOCATION / DATE --------------------------------------

  it('a promotion scoped to another location does not apply', async () => {
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'FIXED_AMOUNT',
      discountValue: 200,
      appliesToAllLocations: false,
      locationIds: [otherLocationId],
    });
    const confirmation = await checkoutService.checkout(
      req([line(latteId)]),
      undefined,
    );
    expect(confirmation.promotionDiscount).toBe(0);
    expect(confirmation.orderPromotion).toBeNull();
  });

  it('an expired promotion does not apply', async () => {
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'FIXED_AMOUNT',
      discountValue: 200,
      endsAt: new Date(Date.now() - 60_000),
    });
    const confirmation = await checkoutService.checkout(
      req([line(latteId)]),
      undefined,
    );
    expect(confirmation.promotionDiscount).toBe(0);
  });

  // --- STACKING with Mocha Bean reward ----------------------

  it('regular discount + fixed Mocha Bean reward: reward is capped at remaining merchandise', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 500);
    const customerId = await customerIdFor(id);
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'FIXED_AMOUNT',
      discountValue: 600,
    });
    const rewardId = await makeFixedReward(100, 500); // $5 off

    // Cart $9. -$6 promo -> $3 remaining. -$5 reward capped to $3 -> $0.
    const confirmation = await checkoutService.checkout(
      req([line(latteId), line(muffinId)], { loyaltyRewardId: rewardId }),
      id,
    );
    expect(confirmation.subtotal).toBe(900);
    expect(confirmation.promotionDiscount).toBe(600);
    expect(confirmation.rewardDiscount).toBe(300); // capped
    expect(confirmation.total).toBe(0);

    const order = await orderFor(confirmation.orderId);
    expect(order.paymentAttempt.amount).toBe(0);

    const ledger = await ledgerFor(customerId);
    expect(ledger.find((e) => e.type === 'REDEEM')!.amount).toBe(-100); // full cost
    // net $0 -> no standard EARN
    expect(ledger.find((e) => e.type === 'EARN')).toBeUndefined();
  });

  it('regular FREE_ITEM + Mocha Bean FREE_ITEM reward on the same product: two units freed, never over-discounted', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 500);
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'FREE_ITEM',
      applicability: 'SELECTED_PRODUCTS',
      productIds: [latteId],
    });
    const rewardId = await makeFreeItemReward(100, [latteId]);

    // 3 lattes @ $5 = $15. promo frees one ($5), reward frees another ($5).
    const confirmation = await checkoutService.checkout(
      req([line(latteId, 3)], { loyaltyRewardId: rewardId }),
      id,
    );
    expect(confirmation.subtotal).toBe(1500);
    expect(confirmation.promotionDiscount).toBe(500);
    expect(confirmation.rewardDiscount).toBe(500);
    expect(confirmation.total).toBe(500); // one latte still paid
  });

  it('the reward is rejected when the regular FREE_ITEM already freed the only eligible unit', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 500);
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'FREE_ITEM',
      applicability: 'SELECTED_PRODUCTS',
      productIds: [latteId],
    });
    const rewardId = await makeFreeItemReward(100, [latteId]);

    // Only 1 latte — promo frees it, reward has nothing left to free.
    await expect(
      checkoutService.checkout(
        req([line(latteId), line(muffinId)], { loyaltyRewardId: rewardId }),
        id,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('combined discounts never exceed the merchandise subtotal', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 500);
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'FIXED_AMOUNT',
      discountValue: 100000,
    });
    const rewardId = await makeFixedReward(100, 100000);
    const confirmation = await checkoutService.checkout(
      req([line(pastryId)], { loyaltyRewardId: rewardId }), // $3
      id,
    );
    expect(confirmation.total).toBe(0);
    expect(
      confirmation.promotionDiscount + confirmation.rewardDiscount,
    ).toBeLessThanOrEqual(confirmation.subtotal);
  });

  // --- MOCHA BEANS EARNING ---------------------------------

  it('standard EARN and bonus use the final post-discount merchandise', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'FIXED_AMOUNT',
      discountValue: 300,
    });
    await prisma.loyaltyBonusPromotion.create({
      data: {
        name: `Bonus ${randomUUID()} ${suffix}`,
        type: 'MULTIPLIER',
        bonusValue: 2,
        isActive: true,
        appliesToAllLocations: true,
        eligibleProducts: { create: [{ productId: latteId }] },
      },
    });

    // Cart $9. -$3 promo -> net $6. standard EARN = 6.
    // Bonus MULTIPLIER on latte: latte's share of the $3 discount ~
    // 3 * 500/900 = 166 -> latte qualifying $3.34 -> 3 standard -> +3 bonus.
    const confirmation = await checkoutService.checkout(
      req([line(latteId), line(muffinId)]),
      id,
    );
    expect(confirmation.total).toBe(600);

    const ledger = await ledgerFor(customerId);
    expect(ledger.find((e) => e.type === 'EARN')!.amount).toBe(6);
    expect(ledger.find((e) => e.type === 'BONUS_EARN')!.amount).toBe(3);
    expect(await balanceOf(customerId)).toBe(9);

    await prisma.loyaltyBonusPromotion.deleteMany({
      where: { name: { contains: suffix } },
    });
  });

  // --- TARGETED DISCOUNT ATTRIBUTION (7E MAJOR-1 correction) --------

  it('a SELECTED_PRODUCTS discount does NOT reduce an unrelated product’s Bonus Beans', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    // 50% off the latte only.
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'PERCENTAGE_OFF',
      discountValue: 50,
      applicability: 'SELECTED_PRODUCTS',
      productIds: [latteId],
    });
    // 2x Bonus Beans on the muffin (a different product).
    await prisma.loyaltyBonusPromotion.create({
      data: {
        name: `Bonus ${randomUUID()} ${suffix}`,
        type: 'MULTIPLIER',
        bonusValue: 2,
        isActive: true,
        appliesToAllLocations: true,
        eligibleProducts: { create: [{ productId: muffinId }] },
      },
    });

    // latte $5 + muffin $4. -50% latte -> $2.50 discount, all on the latte.
    const confirmation = await checkoutService.checkout(
      req([line(latteId), line(muffinId)]),
      id,
    );
    expect(confirmation.promotionDiscount).toBe(250);
    expect(confirmation.total).toBe(650); // $9 - $2.50

    const ledger = await ledgerFor(customerId);
    // standard EARN on net $6.50 -> 6
    expect(ledger.find((e) => e.type === 'EARN')!.amount).toBe(6);
    // muffin untouched -> qualifying $4 -> 4 standard -> +4 bonus (NOT +2).
    const snapshot = await prisma.orderLoyaltyBonus.findUnique({
      where: { orderId: confirmation.orderId },
      include: { items: true },
    });
    expect(snapshot?.items[0].productId).toBe(muffinId);
    expect(snapshot?.items[0].qualifyingSpendMinorUnits).toBe(400);
    expect(ledger.find((e) => e.type === 'BONUS_EARN')!.amount).toBe(4);

    await prisma.loyaltyBonusPromotion.deleteMany({
      where: { name: { contains: suffix } },
    });
  });

  it('a SELECTED_CATEGORIES discount does NOT reduce an unrelated category item’s Bonus Beans', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    // 50% off the whole food category.
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'PERCENTAGE_OFF',
      discountValue: 50,
      applicability: 'SELECTED_CATEGORIES',
      categoryIds: [foodCategoryId],
    });
    // 2x Bonus Beans on the latte (drinks — unrelated category).
    await prisma.loyaltyBonusPromotion.create({
      data: {
        name: `Bonus ${randomUUID()} ${suffix}`,
        type: 'MULTIPLIER',
        bonusValue: 2,
        isActive: true,
        appliesToAllLocations: true,
        eligibleProducts: { create: [{ productId: latteId }] },
      },
    });

    // latte $5 + pastry $3 + muffin $4. -50% of the $7 food -> $3.50.
    const confirmation = await checkoutService.checkout(
      req([line(latteId), line(pastryId), line(muffinId)]),
      id,
    );
    expect(confirmation.promotionDiscount).toBe(350);

    const snapshot = await prisma.orderLoyaltyBonus.findUnique({
      where: { orderId: confirmation.orderId },
      include: { items: true },
    });
    // latte untouched -> qualifying $5 -> 5 standard -> +5 bonus (NOT +3).
    expect(snapshot?.items[0].productId).toBe(latteId);
    expect(snapshot?.items[0].qualifyingSpendMinorUnits).toBe(500);
    expect(
      (await ledgerFor(customerId)).find((e) => e.type === 'BONUS_EARN')!.amount,
    ).toBe(5);

    await prisma.loyaltyBonusPromotion.deleteMany({
      where: { name: { contains: suffix } },
    });
  });

  it('a SELECTED_PRODUCTS discount DOES reduce the discounted product’s own Bonus Beans', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'PERCENTAGE_OFF',
      discountValue: 50,
      applicability: 'SELECTED_PRODUCTS',
      productIds: [latteId],
    });
    await prisma.loyaltyBonusPromotion.create({
      data: {
        name: `Bonus ${randomUUID()} ${suffix}`,
        type: 'MULTIPLIER',
        bonusValue: 2,
        isActive: true,
        appliesToAllLocations: true,
        eligibleProducts: { create: [{ productId: latteId }] },
      },
    });

    // latte $5, -50% -> latte qualifying $2.50 -> 2 standard -> +2 bonus.
    const confirmation = await checkoutService.checkout(
      req([line(latteId), line(muffinId)]),
      id,
    );
    const snapshot = await prisma.orderLoyaltyBonus.findUnique({
      where: { orderId: confirmation.orderId },
      include: { items: true },
    });
    expect(snapshot?.items[0].productId).toBe(latteId);
    expect(snapshot?.items[0].qualifyingSpendMinorUnits).toBe(250);
    expect(
      (await ledgerFor(customerId)).find((e) => e.type === 'BONUS_EARN')!.amount,
    ).toBe(2);

    await prisma.loyaltyBonusPromotion.deleteMany({
      where: { name: { contains: suffix } },
    });
  });

  // --- FREE_ITEM UNIT PRECISION (7E MINOR-1 correction) ------------

  it('regular FREE_ITEM + reward FREE_ITEM: the actual freed priced units are identified across two lines', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 500);
    // Regular FREE_ITEM on the latte; reward FREE_ITEM on the latte.
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'FREE_ITEM',
      applicability: 'SELECTED_PRODUCTS',
      productIds: [latteId],
    });
    const rewardId = await makeFreeItemReward(100, [latteId]);

    // Cart: one Large latte ($7, listed first) + one Small latte ($5).
    // The regular promo frees the LOWEST-priced unit = the $5 Small.
    // The reward must then free the remaining $7 Large — total merchandise $0.
    const confirmation = await checkoutService.checkout(
      req(
        [
          {
            productId: latteId,
            quantity: 1,
            selections: [{ groupId: sizeGroupId, optionIds: [sizeLargeId] }],
          },
          {
            productId: latteId,
            quantity: 1,
            selections: [{ groupId: sizeGroupId, optionIds: [sizeSmallId] }],
          },
        ],
        { loyaltyRewardId: rewardId },
      ),
      id,
    );
    expect(confirmation.subtotal).toBe(1200); // $7 + $5
    expect(confirmation.promotionDiscount).toBe(500); // the $5 Small
    expect(confirmation.rewardDiscount).toBe(700); // the $7 Large
    expect(confirmation.total).toBe(0);
    // No overcharge, no over-discount.
    expect(
      confirmation.promotionDiscount + confirmation.rewardDiscount,
    ).toBe(confirmation.subtotal);
  });

  it('regular FREE_ITEM + reward FREE_ITEM: quantity > 1 on one line still frees two distinct units', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 500);
    await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'FREE_ITEM',
      applicability: 'SELECTED_PRODUCTS',
      productIds: [latteId],
    });
    const rewardId = await makeFreeItemReward(100, [latteId]);

    // 3 Small lattes @ $5 on one line -> promo frees one, reward frees one,
    // one still paid.
    const confirmation = await checkoutService.checkout(
      req([line(latteId, 3)], { loyaltyRewardId: rewardId }),
      id,
    );
    expect(confirmation.subtotal).toBe(1500);
    expect(confirmation.promotionDiscount).toBe(500);
    expect(confirmation.rewardDiscount).toBe(500);
    expect(confirmation.total).toBe(500);
  });

  // --- LIMITS ---------------------------------------------

  it('a total redemption limit stops further successful use', async () => {
    const promotionId = await makePromotion({
      kind: 'COUPON',
      code: 'ONCEONLY',
      discountType: 'FIXED_AMOUNT',
      discountValue: 100,
      totalRedemptionLimit: 1,
    });
    await checkoutService.checkout(
      req([line(latteId)], { couponCode: 'ONCEONLY' }),
      undefined,
    );
    // Second use — the limit is now reached.
    await expect(
      checkoutService.checkout(
        req([line(latteId)], { couponCode: 'ONCEONLY' }),
        undefined,
      ),
    ).rejects.toBeDefined();
    const promotion = await prisma.promotion.findUniqueOrThrow({
      where: { id: promotionId },
    });
    expect(promotion.redemptionCount).toBe(1);
  });

  it('a per-customer limit requires sign-in and stops a second use by that customer', async () => {
    await makePromotion({
      kind: 'COUPON',
      code: 'PERCUST1',
      discountType: 'FIXED_AMOUNT',
      discountValue: 100,
      perCustomerRedemptionLimit: 1,
    });
    // Guest -> rejected (sign-in required).
    await expect(
      checkoutService.checkout(
        req([line(latteId)], { couponCode: 'PERCUST1' }),
        undefined,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    const id = identity(randomUUID());
    await grantBeans(id, 0);
    await checkoutService.checkout(
      req([line(latteId)], { couponCode: 'PERCUST1' }),
      id,
    );
    // Same customer, second use -> rejected.
    await expect(
      checkoutService.checkout(
        req([line(latteId)], { couponCode: 'PERCUST1' }),
        id,
      ),
    ).rejects.toBeDefined();
  });

  it('a declined payment does not consume a redemption', async () => {
    const promotionId = await makePromotion({
      kind: 'COUPON',
      code: 'DECLINE1',
      discountType: 'FIXED_AMOUNT',
      discountValue: 100,
      totalRedemptionLimit: 5,
    });
    await expect(
      checkoutService.checkout(
        req([line(latteId)], {
          couponCode: 'DECLINE1',
          guest: {
            name: 'Declined',
            phone: FakePaymentProvider.DECLINE_TEST_PHONE,
          },
        }),
        undefined,
      ),
    ).rejects.toBeDefined();
    const promotion = await prisma.promotion.findUniqueOrThrow({
      where: { id: promotionId },
    });
    expect(promotion.redemptionCount).toBe(0);
  });

  it('a post-payment transaction failure consumes no redemption and persists no snapshot', async () => {
    const promotionId = await makePromotion({
      kind: 'COUPON',
      code: 'ROLLBACK1',
      discountType: 'FIXED_AMOUNT',
      discountValue: 100,
      totalRedemptionLimit: 5,
    });
    const request = req([line(latteId)], { couponCode: 'ROLLBACK1' });
    jest
      .spyOn(prisma, '$transaction')
      .mockRejectedValueOnce(new Error('Simulated order transaction failure'));
    await expect(checkoutService.checkout(request, undefined)).rejects.toThrow(
      'Simulated order transaction failure',
    );
    const attempt = await prisma.paymentAttempt.findUniqueOrThrow({
      where: { idempotencyKey: request.idempotencyKey },
    });
    expect(attempt.status).toBe('SUCCEEDED');
    expect(attempt.reconciliationRequired).toBe(true);
    const promotion = await prisma.promotion.findUniqueOrThrow({
      where: { id: promotionId },
    });
    expect(promotion.redemptionCount).toBe(0);
    const redemptions = await prisma.orderPromotionRedemption.findMany({
      where: { sourcePromotionId: promotionId },
    });
    expect(redemptions).toHaveLength(0);
  });

  it('total limit = 1 under concurrency: at most one successful redemption', async () => {
    const promotionId = await makePromotion({
      kind: 'COUPON',
      code: 'RACE1',
      discountType: 'FIXED_AMOUNT',
      discountValue: 100,
      totalRedemptionLimit: 1,
    });
    const results = await Promise.allSettled([
      checkoutService.checkout(
        req([line(latteId)], { couponCode: 'RACE1' }),
        undefined,
      ),
      checkoutService.checkout(
        req([line(latteId)], { couponCode: 'RACE1' }),
        undefined,
      ),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled.length).toBeLessThanOrEqual(1);
    const promotion = await prisma.promotion.findUniqueOrThrow({
      where: { id: promotionId },
    });
    expect(promotion.redemptionCount).toBe(1);
    const redemptions = await prisma.orderPromotionRedemption.findMany({
      where: { sourcePromotionId: promotionId },
    });
    expect(redemptions).toHaveLength(1);
  });

  // --- IDEMPOTENCY ----------------------------------------

  it('checkout replay does not consume a second redemption or create a duplicate snapshot', async () => {
    const promotionId = await makePromotion({
      kind: 'COUPON',
      code: 'REPLAY1',
      discountType: 'FIXED_AMOUNT',
      discountValue: 100,
      totalRedemptionLimit: 5,
    });
    const request = req([line(latteId)], { couponCode: 'REPLAY1' });
    const first = await checkoutService.checkout(request, undefined);
    const second = await checkoutService.checkout(request, undefined);
    expect(second.orderId).toBe(first.orderId);
    const promotion = await prisma.promotion.findUniqueOrThrow({
      where: { id: promotionId },
    });
    expect(promotion.redemptionCount).toBe(1);
    const redemptions = await prisma.orderPromotionRedemption.findMany({
      where: { orderId: first.orderId },
    });
    expect(redemptions).toHaveLength(1);
  });

  // --- HISTORY -------------------------------------------

  it('editing or deactivating the promotion after the order never changes the snapshot', async () => {
    const promotionId = await makePromotion({
      kind: 'AUTOMATIC',
      discountType: 'FIXED_AMOUNT',
      discountValue: 200,
    });
    const confirmation = await checkoutService.checkout(
      req([line(latteId)]),
      undefined,
    );
    const before = await prisma.orderPromotionRedemption.findUniqueOrThrow({
      where: { orderId: confirmation.orderId },
    });
    await prisma.promotion.update({
      where: { id: promotionId },
      data: { name: 'Renamed', discountValue: 999, isActive: false },
    });
    const after = await prisma.orderPromotionRedemption.findUniqueOrThrow({
      where: { orderId: confirmation.orderId },
    });
    expect(after.promotionName).toBe(before.promotionName);
    expect(after.discountValue).toBe(200);
    expect(after.discountMinorUnits).toBe(200);

    const status = await checkoutService.getStatus(
      confirmation.orderId,
      confirmation.accessToken,
    );
    expect(status.orderPromotion?.name).toBe(before.promotionName);
    expect(status.promotionDiscount).toBe(200);
  });

  // --- REGRESSION ---------------------------------------

  it('an order with no promotion or coupon is unchanged', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    const confirmation = await checkoutService.checkout(req([line(latteId)]), id);
    expect(confirmation.promotionDiscount).toBe(0);
    expect(confirmation.orderPromotion).toBeNull();
    expect(confirmation.total).toBe(confirmation.subtotal);
    const ledger = await ledgerFor(customerId);
    expect(ledger.find((e) => e.type === 'EARN')!.amount).toBe(5);
  });
});
