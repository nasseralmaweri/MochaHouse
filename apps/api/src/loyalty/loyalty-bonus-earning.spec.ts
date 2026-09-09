import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
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
import { PromotionsModule } from '../promotions/promotions.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';

// Milestone 7D — Bonus Mocha Beans Promotions, exercised end-to-end through
// the real CheckoutService against local Postgres. A dedicated test
// location + menu with priced products gives full control over EXTRA_BEANS
// / MULTIPLIER eligibility, quantity, location + date windows, and the
// Milestone 7C reward interactions.
describe('Bonus Mocha Beans Promotions at checkout (integration)', () => {
  let prisma: PrismaService;
  let checkoutService: CheckoutService;

  const suffix = randomUUID();
  const KEY_PREFIX = 'test_bonus_';
  const SUBJECT_PREFIX = 'test-bonus-';

  let locationId: string;
  let otherLocationId: string;
  let drinksCategoryId: string;
  let foodCategoryId: string;
  let matchaId: string; // drinks, $6.00
  let latteId: string; // drinks, $5.00
  let pastryId: string; // food, $3.00
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
      ],
      providers: [
        CheckoutService,
        { provide: PAYMENT_PROVIDER, useClass: FakePaymentProvider },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    checkoutService = moduleRef.get(CheckoutService);
    await prisma.$connect();

    await prisma.loyaltyConfiguration.upsert({
      where: { key: 'company' },
      update: { earningRatePerDollar: 1 },
      create: { key: 'company', earningRatePerDollar: 1 },
    });

    const mkLocation = (n: string) =>
      prisma.location.create({
        data: {
          name: `Bonus Loc ${n} ${suffix}`,
          slug: `bonus-loc-${n}-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      });
    locationId = (await mkLocation('a')).id;
    otherLocationId = (await mkLocation('b')).id;

    drinksCategoryId = (
      await prisma.category.create({
        data: { name: `Bonus Drinks ${suffix}`, slug: `bonus-drinks-${suffix}` },
      })
    ).id;
    foodCategoryId = (
      await prisma.category.create({
        data: { name: `Bonus Food ${suffix}`, slug: `bonus-food-${suffix}` },
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
    matchaId = (await mk('Bonus Matcha', 'bonus-matcha', 600, drinksCategoryId)).id;
    latteId = (await mk('Bonus Latte', 'bonus-latte', 500, drinksCategoryId)).id;
    pastryId = (await mk('Bonus Pastry', 'bonus-pastry', 300, foodCategoryId)).id;

    const menu = await prisma.menu.create({
      data: { name: `Bonus Menu ${suffix}`, slug: `bonus-menu-${suffix}` },
    });
    await prisma.menuProduct.createMany({
      data: [matchaId, latteId, pastryId].map((productId, i) => ({
        menuId: menu.id,
        productId,
        displayOrder: i,
        isActive: true,
      })),
    });
    // Both test locations share the menu.
    await prisma.locationMenu.createMany({
      data: [locationId, otherLocationId].map((locId) => ({
        locationId: locId,
        menuId: menu.id,
        isActive: true,
      })),
    });
  });

  afterEach(async () => {
    if (promotionIds.length > 0) {
      await prisma.loyaltyBonusPromotionProduct.deleteMany({
        where: { promotionId: { in: promotionIds } },
      });
      await prisma.loyaltyBonusPromotionLocation.deleteMany({
        where: { promotionId: { in: promotionIds } },
      });
    }
    jest.restoreAllMocks();
  });

  afterAll(async () => {
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

    await prisma.loyaltyBonusPromotion.deleteMany({
      where: { id: { in: promotionIds } },
    });
    await prisma.loyaltyReward.deleteMany({
      where: { name: { contains: suffix } },
    });
    await prisma.menuProduct.deleteMany({
      where: { productId: { in: [matchaId, latteId, pastryId] } },
    });
    await prisma.locationMenu.deleteMany({
      where: { locationId: { in: [locationId, otherLocationId] } },
    });
    await prisma.menu.deleteMany({ where: { slug: `bonus-menu-${suffix}` } });
    await prisma.product.deleteMany({
      where: { id: { in: [matchaId, latteId, pastryId] } },
    });
    await prisma.category.deleteMany({
      where: { id: { in: [drinksCategoryId, foodCategoryId] } },
    });
    await prisma.location.deleteMany({
      where: { id: { in: [locationId, otherLocationId] } },
    });
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
    type: 'EXTRA_BEANS' | 'MULTIPLIER';
    bonusValue: number;
    productIds: string[];
    appliesToAllLocations?: boolean;
    locationIds?: string[];
    isActive?: boolean;
    startsAt?: Date | null;
    endsAt?: Date | null;
  }): Promise<string> {
    const promotion = await prisma.loyaltyBonusPromotion.create({
      data: {
        name: `Bonus ${opts.type} ${randomUUID()} ${suffix}`,
        type: opts.type,
        bonusValue: opts.bonusValue,
        isActive: opts.isActive ?? true,
        appliesToAllLocations: opts.appliesToAllLocations ?? true,
        startsAt: opts.startsAt ?? null,
        endsAt: opts.endsAt ?? null,
        eligibleProducts: {
          create: opts.productIds.map((productId) => ({ productId })),
        },
        eligibleLocations: opts.locationIds
          ? { create: opts.locationIds.map((locId) => ({ locationId: locId })) }
          : undefined,
      },
    });
    promotionIds.push(promotion.id);
    return promotion.id;
  }

  async function makeFreeItemReward(
    beanCost: number,
    productIds: string[],
  ): Promise<string> {
    const reward = await prisma.loyaltyReward.create({
      data: {
        name: `Free Item ${randomUUID()} ${suffix}`,
        type: 'FREE_ITEM',
        beanCost,
        eligibleProducts: { create: productIds.map((productId) => ({ productId })) },
      },
    });
    return reward.id;
  }

  async function makeFixedReward(
    beanCost: number,
    fixedAmountMinorUnits: number,
  ): Promise<string> {
    const reward = await prisma.loyaltyReward.create({
      data: {
        name: `Fixed Off ${randomUUID()} ${suffix}`,
        type: 'FIXED_AMOUNT',
        beanCost,
        fixedAmountMinorUnits,
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
      guest: { name: 'Bonus Guest', phone: '5551234567' },
      lines,
      ...over,
    };
  }

  const line = (productId: string, quantity = 1) => ({
    productId,
    quantity,
    selections: [],
  });

  async function bonusFor(orderId: string) {
    return prisma.orderLoyaltyBonus.findUnique({
      where: { orderId },
      include: { items: true },
    });
  }

  // --- EXTRA_BEANS ----------------------------------------------

  it('EXTRA_BEANS: eligible product earns standard + extra; ledger has both entries', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({ type: 'EXTRA_BEANS', bonusValue: 20, productIds: [matchaId] });

    const confirmation = await checkoutService.checkout(
      req([line(matchaId)]), // $6
      id,
    );

    const ledger = await ledgerFor(customerId);
    const earn = ledger.find((e) => e.type === 'EARN')!;
    const bonus = ledger.find((e) => e.type === 'BONUS_EARN')!;
    expect(earn.amount).toBe(6);
    expect(bonus.amount).toBe(20);
    expect(bonus.orderId).toBe(confirmation.orderId);
    expect(await balanceOf(customerId)).toBe(26);

    const snapshot = await bonusFor(confirmation.orderId);
    expect(snapshot?.totalBonusBeans).toBe(20);
    expect(snapshot?.items).toHaveLength(1);
    expect(snapshot?.items[0]).toMatchObject({
      promotionType: 'EXTRA_BEANS',
      productId: matchaId,
      qualifyingUnits: 1,
      bonusBeans: 20,
    });
  });

  it('EXTRA_BEANS: quantity multiplies the bonus per paid unit', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({ type: 'EXTRA_BEANS', bonusValue: 10, productIds: [latteId] });

    await checkoutService.checkout(req([line(latteId, 3)]), id); // 3 x $5

    const ledger = await ledgerFor(customerId);
    expect(ledger.find((e) => e.type === 'EARN')!.amount).toBe(15);
    expect(ledger.find((e) => e.type === 'BONUS_EARN')!.amount).toBe(30);
  });

  it('a non-target product in the cart earns no bonus', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({ type: 'EXTRA_BEANS', bonusValue: 20, productIds: [matchaId] });

    const confirmation = await checkoutService.checkout(req([line(latteId)]), id);

    const ledger = await ledgerFor(customerId);
    expect(ledger.find((e) => e.type === 'BONUS_EARN')).toBeUndefined();
    expect(await bonusFor(confirmation.orderId)).toBeNull();
    expect(await balanceOf(customerId)).toBe(5);
  });

  it('the configured standard rate applies independently of the flat bonus', async () => {
    await prisma.loyaltyConfiguration.update({
      where: { key: 'company' },
      data: { earningRatePerDollar: 2 },
    });
    try {
      const id = identity(randomUUID());
      await grantBeans(id, 0);
      const customerId = await customerIdFor(id);
      await makePromotion({
        type: 'EXTRA_BEANS',
        bonusValue: 20,
        productIds: [matchaId],
      });

      await checkoutService.checkout(req([line(matchaId)]), id); // $6

      const ledger = await ledgerFor(customerId);
      expect(ledger.find((e) => e.type === 'EARN')!.amount).toBe(12); // 6 * rate 2
      expect(ledger.find((e) => e.type === 'BONUS_EARN')!.amount).toBe(20);
    } finally {
      await prisma.loyaltyConfiguration.update({
        where: { key: 'company' },
        data: { earningRatePerDollar: 1 },
      });
    }
  });

  // --- MULTIPLIER ----------------------------------------------

  it('MULTIPLIER: 2x means total item earning is twice standard, not triple', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({ type: 'MULTIPLIER', bonusValue: 2, productIds: [matchaId] });

    await checkoutService.checkout(req([line(matchaId)]), id); // $6 -> 6 standard

    const ledger = await ledgerFor(customerId);
    expect(ledger.find((e) => e.type === 'EARN')!.amount).toBe(6);
    expect(ledger.find((e) => e.type === 'BONUS_EARN')!.amount).toBe(6);
    // total earned = 12, i.e. exactly 2x the standard 6
    expect(await balanceOf(customerId)).toBe(12);
  });

  it('MULTIPLIER: respects the configured standard rate', async () => {
    await prisma.loyaltyConfiguration.update({
      where: { key: 'company' },
      data: { earningRatePerDollar: 2 },
    });
    try {
      const id = identity(randomUUID());
      await grantBeans(id, 0);
      const customerId = await customerIdFor(id);
      await makePromotion({
        type: 'MULTIPLIER',
        bonusValue: 2,
        productIds: [latteId],
      });

      await checkoutService.checkout(req([line(latteId)]), id); // $5 -> 10 standard

      const ledger = await ledgerFor(customerId);
      expect(ledger.find((e) => e.type === 'EARN')!.amount).toBe(10);
      expect(ledger.find((e) => e.type === 'BONUS_EARN')!.amount).toBe(10);
    } finally {
      await prisma.loyaltyConfiguration.update({
        where: { key: 'company' },
        data: { earningRatePerDollar: 1 },
      });
    }
  });

  it('MULTIPLIER: applies per qualifying unit for quantity > 1', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({ type: 'MULTIPLIER', bonusValue: 2, productIds: [latteId] });

    await checkoutService.checkout(req([line(latteId, 3)]), id); // 3 x $5 -> 15

    const ledger = await ledgerFor(customerId);
    expect(ledger.find((e) => e.type === 'BONUS_EARN')!.amount).toBe(15);
  });

  it('only the promoted item earns the multiplier, not the whole order', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({ type: 'MULTIPLIER', bonusValue: 2, productIds: [matchaId] });

    const confirmation = await checkoutService.checkout(
      req([line(matchaId), line(pastryId)]), // $6 promoted + $3 plain
      id,
    );

    const ledger = await ledgerFor(customerId);
    expect(ledger.find((e) => e.type === 'EARN')!.amount).toBe(9); // whole order
    expect(ledger.find((e) => e.type === 'BONUS_EARN')!.amount).toBe(6); // matcha only
    const snapshot = await bonusFor(confirmation.orderId);
    expect(snapshot?.items).toHaveLength(1);
    expect(snapshot?.items[0].productId).toBe(matchaId);
  });

  // --- BEST PROMOTION ----------------------------------------

  it('when two promotions apply, only the single highest-value one is used', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({ type: 'EXTRA_BEANS', bonusValue: 10, productIds: [matchaId] });
    await makePromotion({ type: 'MULTIPLIER', bonusValue: 2, productIds: [matchaId] });

    const confirmation = await checkoutService.checkout(req([line(matchaId)]), id); // $6

    // +10 EXTRA beats +6 multiplier contribution.
    const ledger = await ledgerFor(customerId);
    expect(ledger.find((e) => e.type === 'BONUS_EARN')!.amount).toBe(10);
    const snapshot = await bonusFor(confirmation.orderId);
    expect(snapshot?.items).toHaveLength(1);
    expect(snapshot?.items[0].promotionType).toBe('EXTRA_BEANS');
  });

  it('deterministic tie-break: the earliest-created promotion wins', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    // $10 latte x2 -> 10 standard for the line. +10 EXTRA vs 2x (+10): a tie.
    const firstId = await makePromotion({
      type: 'EXTRA_BEANS',
      bonusValue: 5,
      productIds: [latteId],
    });
    await new Promise((r) => setTimeout(r, 10));
    await makePromotion({ type: 'MULTIPLIER', bonusValue: 2, productIds: [latteId] });

    const confirmation = await checkoutService.checkout(
      req([line(latteId, 2)]), // 2 x $5 -> 10 standard; EXTRA 5*2=10; MULT 10*(2-1)=10
      id,
    );
    const snapshot = await bonusFor(confirmation.orderId);
    expect(snapshot?.totalBonusBeans).toBe(10);
    expect(snapshot?.items[0].sourcePromotionId).toBe(firstId);
  });

  // --- LOCATION ---------------------------------------------

  it('an all-locations promotion applies at this location', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({
      type: 'EXTRA_BEANS',
      bonusValue: 15,
      productIds: [matchaId],
      appliesToAllLocations: true,
    });

    await checkoutService.checkout(req([line(matchaId)]), id);
    const ledger = await ledgerFor(customerId);
    expect(ledger.find((e) => e.type === 'BONUS_EARN')!.amount).toBe(15);
  });

  it('a selected-locations promotion applies only where the order is placed', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({
      type: 'EXTRA_BEANS',
      bonusValue: 15,
      productIds: [matchaId],
      appliesToAllLocations: false,
      locationIds: [locationId],
    });

    await checkoutService.checkout(req([line(matchaId)]), id);
    expect(
      (await ledgerFor(customerId)).find((e) => e.type === 'BONUS_EARN')!.amount,
    ).toBe(15);
  });

  it('a promotion scoped to another location does not apply here', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({
      type: 'EXTRA_BEANS',
      bonusValue: 15,
      productIds: [matchaId],
      appliesToAllLocations: false,
      locationIds: [otherLocationId],
    });

    const confirmation = await checkoutService.checkout(req([line(matchaId)]), id);
    expect(await bonusFor(confirmation.orderId)).toBeNull();
    expect(await balanceOf(customerId)).toBe(6); // standard only
  });

  // --- DATE / ACTIVE ---------------------------------------

  it('an inactive promotion awards no bonus', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({
      type: 'EXTRA_BEANS',
      bonusValue: 20,
      productIds: [matchaId],
      isActive: false,
    });

    const confirmation = await checkoutService.checkout(req([line(matchaId)]), id);
    expect(await bonusFor(confirmation.orderId)).toBeNull();
    expect(await balanceOf(customerId)).toBe(6);
  });

  it('a promotion before its start date awards no bonus', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({
      type: 'EXTRA_BEANS',
      bonusValue: 20,
      productIds: [matchaId],
      startsAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const confirmation = await checkoutService.checkout(req([line(matchaId)]), id);
    expect(await bonusFor(confirmation.orderId)).toBeNull();
  });

  it('a promotion inside its window awards the bonus', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({
      type: 'EXTRA_BEANS',
      bonusValue: 20,
      productIds: [matchaId],
      startsAt: new Date(Date.now() - 60 * 60 * 1000),
      endsAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    await checkoutService.checkout(req([line(matchaId)]), id);
    expect(
      (await ledgerFor(customerId)).find((e) => e.type === 'BONUS_EARN')!.amount,
    ).toBe(20);
  });

  it('a promotion after its end date awards no bonus', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({
      type: 'EXTRA_BEANS',
      bonusValue: 20,
      productIds: [matchaId],
      endsAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    const confirmation = await checkoutService.checkout(req([line(matchaId)]), id);
    expect(await bonusFor(confirmation.orderId)).toBeNull();
  });

  // --- 7C DISCOUNT INTERACTION -----------------------------

  it('a FREE_ITEM-reward free unit earns no EXTRA_BEANS; remaining paid units do', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 500);
    const customerId = await customerIdFor(id);
    const rewardId = await makeFreeItemReward(100, [matchaId]);
    await makePromotion({ type: 'EXTRA_BEANS', bonusValue: 10, productIds: [matchaId] });

    // 3 matcha @ $6 = $18 gross; one free -> $12 net.
    const confirmation = await checkoutService.checkout(
      req([line(matchaId, 3)], { loyaltyRewardId: rewardId }),
      id,
    );
    expect(confirmation.rewardDiscount).toBe(600);

    const snapshot = await bonusFor(confirmation.orderId);
    expect(snapshot?.items[0].qualifyingUnits).toBe(2); // not 3
    expect(snapshot?.totalBonusBeans).toBe(20); // 10 * 2 paid units

    const ledger = await ledgerFor(customerId);
    // standard EARN on net $12 -> 12
    expect(ledger.find((e) => e.type === 'EARN')!.amount).toBe(12);
    expect(ledger.find((e) => e.type === 'BONUS_EARN')!.amount).toBe(20);
    expect(ledger.find((e) => e.type === 'REDEEM')!.amount).toBe(-100);
  });

  it('a FREE_ITEM-reward free unit earns no spend-based multiplier bonus', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 500);
    const customerId = await customerIdFor(id);
    const rewardId = await makeFreeItemReward(100, [matchaId]);
    await makePromotion({ type: 'MULTIPLIER', bonusValue: 2, productIds: [matchaId] });

    // 1 matcha @ $6, made free -> the only unit is free.
    const confirmation = await checkoutService.checkout(
      req([line(matchaId, 1)], { loyaltyRewardId: rewardId }),
      id,
    );
    expect(await bonusFor(confirmation.orderId)).toBeNull();
    const ledger = await ledgerFor(customerId);
    expect(ledger.find((e) => e.type === 'BONUS_EARN')).toBeUndefined();
    // net $0 -> no standard EARN either
    expect(ledger.find((e) => e.type === 'EARN')).toBeUndefined();
  });

  it('a FIXED_AMOUNT reward reduces the item-level qualifying spend for the multiplier', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 500);
    const customerId = await customerIdFor(id);
    const rewardId = await makeFixedReward(100, 500); // $5 off
    await makePromotion({ type: 'MULTIPLIER', bonusValue: 2, productIds: [matchaId] });

    // matcha $6 + pastry $3 = $9 gross paid; $5 discount allocated in minor
    // units, largest-remainder: matcha 500*600/900 = 333.33 -> 333,
    // pastry 166.67 -> 167. matcha qualifying spend = 600 - 333 = 267.
    const confirmation = await checkoutService.checkout(
      req([line(matchaId), line(pastryId)], { loyaltyRewardId: rewardId }),
      id,
    );
    expect(confirmation.total).toBe(400);

    const snapshot = await bonusFor(confirmation.orderId);
    expect(snapshot?.items[0].qualifyingSpendMinorUnits).toBe(267);
    // $2.67 -> 2 standard for the item -> 2 bonus (2x)
    expect(snapshot?.totalBonusBeans).toBe(2);

    const ledger = await ledgerFor(customerId);
    // standard EARN on net $4 -> 4
    expect(ledger.find((e) => e.type === 'EARN')!.amount).toBe(4);
    expect(ledger.find((e) => e.type === 'BONUS_EARN')!.amount).toBe(2);
  });

  // --- LEDGER / BALANCE ------------------------------------

  it('balance equals the sum of the ledger after a bonus order', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({ type: 'EXTRA_BEANS', bonusValue: 12, productIds: [matchaId] });

    await checkoutService.checkout(req([line(matchaId)]), id);

    const ledger = await ledgerFor(customerId);
    const sum = ledger.reduce((n, e) => n + e.amount, 0);
    expect(sum).toBe(6 + 12); // EARN $6 + BONUS_EARN 12
    expect(await balanceOf(customerId)).toBe(sum);
  });

  // --- HISTORY --------------------------------------------

  it('editing or deactivating the promotion after the order never changes the snapshot', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const promotionId = await makePromotion({
      type: 'EXTRA_BEANS',
      bonusValue: 20,
      productIds: [matchaId],
    });

    const confirmation = await checkoutService.checkout(req([line(matchaId)]), id);
    const before = await bonusFor(confirmation.orderId);

    await prisma.loyaltyBonusPromotion.update({
      where: { id: promotionId },
      data: { name: 'Renamed', bonusValue: 999, isActive: false },
    });

    const after = await bonusFor(confirmation.orderId);
    expect(after?.totalBonusBeans).toBe(before?.totalBonusBeans);
    expect(after?.items[0].promotionName).toBe(before?.items[0].promotionName);
    expect(after?.items[0].bonusValue).toBe(20);
    expect(after?.items[0].bonusBeans).toBe(20);

    const status = await checkoutService.getStatus(
      confirmation.orderId,
      confirmation.accessToken,
    );
    expect(status.loyaltyBonus?.totalBonusBeans).toBe(20);
  });

  // --- IDEMPOTENCY ---------------------------------------

  it('checkout replay does not duplicate the BONUS_EARN entry or the snapshot', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({ type: 'EXTRA_BEANS', bonusValue: 20, productIds: [matchaId] });
    const request = req([line(matchaId)]);

    const first = await checkoutService.checkout(request, id);
    const second = await checkoutService.checkout(request, id);
    expect(second.orderId).toBe(first.orderId);

    const ledger = await ledgerFor(customerId);
    expect(ledger.filter((e) => e.type === 'BONUS_EARN')).toHaveLength(1);
    const snapshots = await prisma.orderLoyaltyBonus.findMany({
      where: { orderId: first.orderId },
    });
    expect(snapshots).toHaveLength(1);
    expect(await balanceOf(customerId)).toBe(26);
  });

  // --- PAYMENT / RECONCILIATION --------------------------

  it('a declined payment awards no bonus', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({ type: 'EXTRA_BEANS', bonusValue: 20, productIds: [matchaId] });

    await expect(
      checkoutService.checkout(
        req([line(matchaId)], {
          guest: { name: 'Declined', phone: FakePaymentProvider.DECLINE_TEST_PHONE },
        }),
        id,
      ),
    ).rejects.toBeDefined();

    expect(await balanceOf(customerId)).toBe(0);
    expect(
      (await ledgerFor(customerId)).filter((e) => e.type === 'BONUS_EARN'),
    ).toHaveLength(0);
  });

  it('a post-payment transaction failure persists no partial bonus', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 0);
    const customerId = await customerIdFor(id);
    await makePromotion({ type: 'EXTRA_BEANS', bonusValue: 20, productIds: [matchaId] });
    const request = req([line(matchaId)]);

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
    expect(await balanceOf(customerId)).toBe(0);
    expect(
      (await ledgerFor(customerId)).filter((e) => e.type === 'BONUS_EARN'),
    ).toHaveLength(0);
  });

  // --- REGRESSION ---------------------------------------

  it('an order with no applicable promotion is completely unaffected', async () => {
    const id = identity(randomUUID());
    await grantBeans(id, 100);
    const customerId = await customerIdFor(id);

    const confirmation = await checkoutService.checkout(req([line(latteId)]), id);
    expect(await bonusFor(confirmation.orderId)).toBeNull();

    const ledger = await ledgerFor(customerId);
    expect(ledger.filter((e) => e.type === 'BONUS_EARN')).toHaveLength(0);
    expect(ledger.find((e) => e.type === 'EARN')!.amount).toBe(5);
    expect(await balanceOf(customerId)).toBe(105);
  });

  it('a guest order earns no bonus even on a promoted product', async () => {
    await makePromotion({ type: 'EXTRA_BEANS', bonusValue: 20, productIds: [matchaId] });
    const confirmation = await checkoutService.checkout(
      req([line(matchaId)]),
      undefined,
    );
    expect(await bonusFor(confirmation.orderId)).toBeNull();
  });
});
