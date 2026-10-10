import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { INTERNAL_PERMISSION_KEYS } from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
} from '@mocha-house/testing';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';
import { GiftCardPublicThrottleGuard } from '../gift-cards/infrastructure/gift-card-public-throttle.guard';

// Security 4B — PLACED orders (POST /api/v1/orders, the real checkout with
// the fake payment provider), not just quotes. Business A is Mocha House,
// business B a second business with an identical catalog and the same
// coupon code. From A's storefront, every attempt to use B's location,
// product, modifier, coupon, gift card or reward must fail — and must leave
// BOTH businesses' financial and loyalty state exactly as it was (no
// payment attempt, order, redemption, gift-card movement or Mocha Bean
// entry). The same operations with A's own records succeed and are stamped
// with A. Order status tokens and customer accounts never cross businesses.

jest.setTimeout(300_000);

type Tag = 'a' | 'b';
const TENANTS: Record<Tag, string> = {
  a: TENANT_1_MOCHA_HOUSE_ID,
  b: TEST_TENANT_B_ID,
};

interface Fixtures {
  locationId: string;
  productId: string;
  groupId: string;
  optionId: string;
  ownCouponCode: string;
  sharedCouponPromotionId: string;
  ownCouponPromotionId: string;
  rewardId: string;
  customerId: string;
  customerSub: string;
  giftCardId: string;
  giftCardCode: string;
  adminUserId: string;
}

describe('Checkout financial isolation (integration)', () => {
  const apps = {} as Record<Tag, INestApplication<App>>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'checkout-financial-internal-secret';
  const customerSecret = 'checkout-financial-customer-secret';
  const suffix = randomUUID().slice(0, 8);
  const sharedCode = `TCF${suffix}`.toUpperCase();
  const F = {} as Record<Tag, Fixtures>;
  const createdA = {
    promotions: [] as string[],
    userIds: [] as string[],
    roleIds: [] as string[],
  };

  async function buildApp(tenantId: string) {
    process.env.SINGLE_TENANT_ID = tenantId;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(GiftCardPublicThrottleGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    return app;
  }

  const adminToken = (tag: Tag) =>
    signInternalDevJwt(
      {
        sub: `internal-dev:tcf-${tag}-${suffix}`,
        email: `tcf-${tag}-${suffix}@example.test`,
        name: null,
      },
      internalSecret,
      3600,
    );
  const customerToken = (tag: Tag) =>
    signDevJwt(
      {
        sub: F[tag].customerSub,
        email: `tcf-${tag}-customer-${suffix}@example.test`,
        name: null,
      },
      customerSecret,
      3600,
    );

  async function fixturesFor(tag: Tag): Promise<Fixtures> {
    const tenantId = TENANTS[tag];
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:tcf-${tag}-${suffix}`,
        email: `tcf-${tag}-${suffix}@example.test`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    const role = await prisma.internalRole.create({
      data: {
        tenantId,
        key: `tcf-${randomUUID()}`,
        displayName: 'Checkout spec role',
        permissions: {
          create: INTERNAL_PERMISSION_KEYS.map((permissionKey) => ({
            permissionKey,
            tenantId,
          })),
        },
      },
    });
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId,
        internalUserId: user.id,
        roleId: role.id,
        scopeType: 'CORPORATE',
      },
    });
    if (tag === 'a') {
      createdA.userIds.push(user.id);
      createdA.roleIds.push(role.id);
    }
    // Identical catalog in both businesses.
    const location = await prisma.location.create({
      data: {
        tenantId,
        name: 'TCF Store',
        slug: `tcf-store-${suffix}`,
        isDigitalOrderingEnabled: true,
      },
    });
    const category = await prisma.category.create({
      data: { tenantId, name: 'TCF Coffee', slug: `tcf-coffee-${suffix}` },
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: 'TCF Latte',
        slug: `tcf-latte-${suffix}`,
        categoryId: category.id,
        basePrice: 1000,
      },
    });
    const menu = await prisma.menu.create({
      data: { tenantId, name: 'TCF Menu', slug: `tcf-menu-${suffix}` },
    });
    await prisma.menuProduct.create({
      data: { tenantId, menuId: menu.id, productId: product.id },
    });
    await prisma.locationMenu.create({
      data: { tenantId, locationId: location.id, menuId: menu.id },
    });
    const group = await prisma.modifierGroup.create({
      data: { tenantId, name: 'TCF Milk', maxSelections: 1 },
    });
    const option = await prisma.modifierOption.create({
      data: {
        tenantId,
        modifierGroupId: group.id,
        name: 'TCF Oat',
        priceAdjustment: 50,
      },
    });
    await prisma.productModifierGroup.create({
      data: { tenantId, productId: product.id, modifierGroupId: group.id },
    });
    // The same coupon code in both businesses, plus a code only this one has.
    const shared = await prisma.promotion.create({
      data: {
        tenantId,
        name: `TCF-${tag} shared coupon`,
        kind: 'COUPON',
        code: sharedCode,
        discountType: 'FIXED_AMOUNT',
        discountValue: 100,
        appliesToAllLocations: true,
      },
    });
    const ownCouponCode = `TCF${tag.toUpperCase()}ONLY${suffix}`.toUpperCase();
    const own = await prisma.promotion.create({
      data: {
        tenantId,
        name: `TCF-${tag} own coupon`,
        kind: 'COUPON',
        code: ownCouponCode,
        discountType: 'FIXED_AMOUNT',
        discountValue: 150,
        appliesToAllLocations: true,
      },
    });
    if (tag === 'a') createdA.promotions.push(shared.id, own.id);
    const reward = await prisma.loyaltyReward.create({
      data: {
        tenantId,
        name: `TCF-${tag} reward`,
        type: 'FIXED_AMOUNT',
        beanCost: 10,
        fixedAmountMinorUnits: 200,
      },
    });
    const customerSub = `dev:tcf-${tag}-${suffix}`;
    const customer = await prisma.customer.create({
      data: {
        tenantId,
        externalProvider: 'dev',
        externalSubject: customerSub,
        email: `tcf-${tag}-customer-${suffix}@example.test`,
      },
    });
    await prisma.customerLoyaltyAccount.create({
      data: { tenantId, customerId: customer.id, balance: 100 },
    });
    const issued = await request(apps[tag].getHttpServer())
      .post('/api/v1/admin/gift-cards')
      .set('Authorization', `Bearer ${adminToken(tag)}`)
      .set('X-Tenant-Id', tenantId)
      .send({ originalValueMinorUnits: 5000 })
      .expect(201);
    const gc = issued.body as { giftCard: { id: string }; code: string };
    return {
      locationId: location.id,
      productId: product.id,
      groupId: group.id,
      optionId: option.id,
      ownCouponCode,
      sharedCouponPromotionId: shared.id,
      ownCouponPromotionId: own.id,
      rewardId: reward.id,
      customerId: customer.id,
      customerSub,
      giftCardId: gc.giftCard.id,
      giftCardCode: gc.code,
      adminUserId: user.id,
    };
  }

  // Every financial / loyalty / order record a business owns.
  const FINANCIAL_MODELS = [
    'paymentAttempt',
    'order',
    'orderLine',
    'orderStatusHistory',
    'orderPromotionRedemption',
    'orderGiftCardRedemption',
    'orderLoyaltyRewardRedemption',
    'orderLoyaltyBonus',
    'promotion',
    'promotionCustomerUsage',
    'giftCard',
    'giftCardTransaction',
    'customerLoyaltyAccount',
    'mochaBeanLedgerEntry',
    'outboxEvent',
  ] as const;
  async function financials(tenantId: string) {
    const out: Record<string, string[]> = {};
    for (const model of FINANCIAL_MODELS) {
      const rows = await (
        prisma as unknown as Record<
          string,
          { findMany(a: object): Promise<object[]> }
        >
      )[model].findMany({
        where: { tenantId },
      });
      out[model] = rows.map((r) => JSON.stringify(r)).sort();
    }
    return out;
  }
  const bothBusinesses = async () => ({
    a: await financials(TENANTS.a),
    b: await financials(TENANTS.b),
  });

  const checkout = (store: Tag, body: object, customer?: Tag) => {
    const req = request(apps[store].getHttpServer()).post('/api/v1/orders');
    if (customer) req.set('Authorization', `Bearer ${customerToken(customer)}`);
    return req.send({
      idempotencyKey: `tcf_${randomUUID()}`,
      guest: { name: 'TCF Guest', phone: '5551234567' },
      ...body,
    });
  };
  const line = (f: Fixtures, selections: object[] = []) => [
    { productId: f.productId, quantity: 1, selections },
  ];

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = customerSecret;
    apps.a = await buildApp(TENANTS.a);
    prisma = apps.a.get(PrismaService);
    await createTestTenantB(prisma);
    apps.b = await buildApp(TENANTS.b);
    F.a = await fixturesFor('a');
    F.b = await fixturesFor('b');
  });

  afterAll(async () => {
    try {
      const del = (model: string, where: object) =>
        (
          prisma as unknown as Record<
            string,
            { deleteMany(a: object): Promise<unknown> }
          >
        )[model].deleteMany({ where });
      // Mocha House: only what this suite created (orders at its own location).
      if (F.a) {
        const orders = (
          await prisma.order.findMany({
            where: { locationId: F.a.locationId },
            select: { id: true },
          })
        ).map((o) => o.id);
        const attempts = (
          await prisma.paymentAttempt.findMany({
            where: { locationId: F.a.locationId },
            select: { id: true },
          })
        ).map((p) => p.id);
        await del('notificationDelivery', {
          outboxEvent: { aggregateId: { in: orders } },
        });
        await del('outboxEvent', { aggregateId: { in: orders } });
        for (const model of [
          'orderPromotionRedemption',
          'orderGiftCardRedemption',
          'orderLoyaltyRewardRedemption',
          'orderLoyaltyBonusItem',
          'orderLoyaltyBonus',
          'orderStatusHistory',
          'orderLine',
        ]) {
          await del(
            model,
            model === 'orderLoyaltyBonusItem'
              ? { orderLoyaltyBonus: { orderId: { in: orders } } }
              : { orderId: { in: orders } },
          );
        }
        await del('mochaBeanLedgerEntry', {
          loyaltyAccount: { customerId: F.a.customerId },
        });
        await del('giftCardTransaction', { giftCardId: F.a.giftCardId });
        await del('order', { id: { in: orders } });
        await del('paymentAttempt', { id: { in: attempts } });
        await del('giftCard', { id: F.a.giftCardId });
        await del('promotionCustomerUsage', {
          promotionId: { in: createdA.promotions },
        });
        await del('promotion', { id: { in: createdA.promotions } });
        await del('loyaltyReward', { id: F.a.rewardId });
        await del('customerLoyaltyAccount', { customerId: F.a.customerId });
        await del('customer', { id: F.a.customerId });
        await del('internalAuditEvent', {
          actorInternalUserId: { in: createdA.userIds },
        });
        await del('productModifierGroup', { productId: F.a.productId });
        await del('modifierOption', { id: F.a.optionId });
        await del('modifierGroup', { id: F.a.groupId });
        await del('locationMenu', { locationId: F.a.locationId });
        const menuIds = (
          await prisma.menuProduct.findMany({
            where: { productId: F.a.productId },
            select: { menuId: true },
          })
        ).map((m) => m.menuId);
        await del('menuProduct', { productId: F.a.productId });
        await del('menu', { id: { in: menuIds } });
        const product = await prisma.product.findUnique({
          where: { id: F.a.productId },
          select: { categoryId: true },
        });
        await del('product', { id: F.a.productId });
        if (product) await del('category', { id: product.categoryId });
        await del('location', { id: F.a.locationId });
        await del('internalUserRoleAssignment', {
          internalUserId: { in: createdA.userIds },
        });
        await del('internalRolePermission', {
          roleId: { in: createdA.roleIds },
        });
        await del('internalRole', { id: { in: createdA.roleIds } });
        await del('internalUser', { id: { in: createdA.userIds } });
      }
      for (const model of [
        'notificationDelivery',
        'outboxEvent',
        'orderPromotionRedemption',
        'orderGiftCardRedemption',
        'orderLoyaltyRewardRedemption',
        'orderLoyaltyBonusItem',
        'orderLoyaltyBonus',
        'orderStatusHistory',
        'orderLine',
        'mochaBeanLedgerEntry',
        'giftCardTransaction',
        'order',
        'paymentAttempt',
        'giftCard',
        'internalAuditEvent',
        'promotionCustomerUsage',
        'promotion',
        'loyaltyReward',
        'customerLoyaltyAccount',
        'customer',
        'productModifierGroup',
        'modifierOption',
        'modifierGroup',
        'locationMenu',
        'menuProduct',
        'menu',
        'product',
        'category',
        'location',
        'internalUserRoleAssignment',
        'internalRolePermission',
        'internalRole',
        'internalUser',
      ]) {
        await del(model, { tenantId: TENANTS.b });
      }
      await removeTestTenantB(prisma);
    } finally {
      await apps.b?.close();
      await apps.a?.close();
      process.env = { ...originalEnv };
    }
  });

  // --- Cross-business attempts: rejected, and nothing financial changes ----

  it.each<
    [
      label: string,
      body: () => object,
      customer: Tag | undefined,
      status: number,
    ]
  >([
    [
      "the other business's location",
      () => ({ locationId: F.b.locationId, lines: line(F.b) }),
      undefined,
      404,
    ],
    [
      "the other business's product",
      () => ({ locationId: F.a.locationId, lines: line(F.b) }),
      undefined,
      400,
    ],
    [
      "the other business's modifier option",
      () => ({
        locationId: F.a.locationId,
        lines: line(F.a, [{ groupId: F.a.groupId, optionIds: [F.b.optionId] }]),
      }),
      undefined,
      400,
    ],
    [
      'a coupon code only the other business has',
      () => ({
        locationId: F.a.locationId,
        lines: line(F.a),
        couponCode: F.b.ownCouponCode,
      }),
      undefined,
      400,
    ],
    [
      "the other business's gift card",
      () => ({
        locationId: F.a.locationId,
        lines: line(F.a),
        giftCardCode: F.b.giftCardCode,
      }),
      undefined,
      400,
    ],
    [
      "the other business's Mocha Bean reward",
      () => ({
        locationId: F.a.locationId,
        lines: line(F.a),
        loyaltyRewardId: F.b.rewardId,
      }),
      'a',
      400,
    ],
    [
      "the other business's signed-in customer account",
      () => ({ locationId: F.a.locationId, lines: line(F.a) }),
      'b',
      403,
    ],
  ])(
    'placing an order with %s is refused and changes nothing',
    async (_label, body, customer, status) => {
      const before = await bothBusinesses();
      const res = await checkout('a', body(), customer);
      expect(res.status).toBe(status);
      expect(await bothBusinesses()).toEqual(before);
    },
  );

  it("the other business's reward is refused exactly like a reward that does not exist", async () => {
    const before = await bothBusinesses();
    const body = (rewardId: string) => ({
      locationId: F.a.locationId,
      lines: line(F.a),
      loyaltyRewardId: rewardId,
    });
    const foreign = await checkout('a', body(F.b.rewardId), 'a');
    const absent = await checkout('a', body(randomUUID()), 'a');
    expect([foreign.status, foreign.body]).toEqual([
      absent.status,
      absent.body,
    ]);
    expect(await bothBusinesses()).toEqual(before);
  });

  it("a selection naming the other business's modifier group is never priced or recorded", async () => {
    // Pricing walks only the ordered product's OWN modifier groups (from the
    // storefront business's menu); a selection for any other group id —
    // here business B's — is ignored, so none of B's data can reach the
    // price or the order record. (Ignoring, rather than rejecting, unknown
    // groups is pre-existing behaviour for every unknown id.)
    const bBefore = await financials(TENANTS.b);
    const res = await checkout('a', {
      locationId: F.a.locationId,
      lines: line(F.a, [{ groupId: F.b.groupId, optionIds: [F.b.optionId] }]),
    }).expect(201);
    const { orderId, subtotal } = res.body as {
      orderId: string;
      subtotal: number;
    };
    expect(subtotal).toBe(1000); // base price only: B's +50 option never applied
    const order = await prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      include: { lines: true },
    });
    expect(order.tenantId).toBe(TENANTS.a);
    const stored = JSON.stringify(order);
    for (const id of [
      F.b.groupId,
      F.b.optionId,
      F.b.productId,
      F.b.locationId,
    ]) {
      expect(stored).not.toContain(id);
    }
    expect(await financials(TENANTS.b)).toEqual(bBefore);
  });

  // --- The same operations with the business's own records succeed --------

  it("the shared coupon code redeems the storefront's OWN coupon only", async () => {
    const bBefore = await financials(TENANTS.b);
    const res = await checkout('a', {
      locationId: F.a.locationId,
      lines: line(F.a),
      couponCode: sharedCode,
    }).expect(201);
    const order = res.body as { orderId: string; promotionDiscount: number };
    expect(order.promotionDiscount).toBe(100);
    const redemption = await prisma.orderPromotionRedemption.findUniqueOrThrow({
      where: { orderId: order.orderId },
    });
    expect([redemption.sourcePromotionId, redemption.tenantId]).toEqual([
      F.a.sharedCouponPromotionId,
      TENANTS.a,
    ]);
    expect(
      (
        await prisma.promotion.findUniqueOrThrow({
          where: { id: F.a.sharedCouponPromotionId },
        })
      ).redemptionCount,
    ).toBe(1);
    expect(await financials(TENANTS.b)).toEqual(bBefore);
  });

  it("an own gift card is charged and recorded in the storefront's business only", async () => {
    const bBefore = await financials(TENANTS.b);
    const res = await checkout('a', {
      locationId: F.a.locationId,
      lines: line(F.a, [{ groupId: F.a.groupId, optionIds: [F.a.optionId] }]),
      giftCardCode: F.a.giftCardCode,
    }).expect(201);
    const order = res.body as {
      orderId: string;
      giftCardTenderMinorUnits: number;
    };
    expect(order.giftCardTenderMinorUnits).toBe(1050);
    const card = await prisma.giftCard.findUniqueOrThrow({
      where: { id: F.a.giftCardId },
      include: { transactions: true },
    });
    expect(card.balanceMinorUnits).toBe(5000 - 1050);
    expect(card.transactions.every((t) => t.tenantId === TENANTS.a)).toBe(true);
    expect(
      card.transactions.reduce((sum, t) => sum + t.amountMinorUnits, 0),
    ).toBe(card.balanceMinorUnits);
    expect(await financials(TENANTS.b)).toEqual(bBefore);
  });

  it("an own reward spends the signed-in customer's own Mocha Beans only", async () => {
    const bBefore = await financials(TENANTS.b);
    const res = await checkout(
      'a',
      {
        locationId: F.a.locationId,
        lines: line(F.a),
        loyaltyRewardId: F.a.rewardId,
      },
      'a',
    ).expect(201);
    const order = res.body as { orderId: string; rewardDiscount: number };
    expect(order.rewardDiscount).toBe(200);
    const entries = await prisma.mochaBeanLedgerEntry.findMany({
      where: { orderId: order.orderId },
    });
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.tenantId === TENANTS.a)).toBe(true);
    const account = await prisma.customerLoyaltyAccount.findUniqueOrThrow({
      where: { customerId: F.a.customerId },
    });
    expect(account.balance).toBe(
      100 + entries.reduce((sum, e) => sum + e.amount, 0),
    );
    expect(await financials(TENANTS.b)).toEqual(bBefore);
  });

  // --- Order access ---------------------------------------------------------

  it('an order status token works only on the storefront of the business that took the order', async () => {
    const res = await checkout('a', {
      locationId: F.a.locationId,
      lines: line(F.a),
    }).expect(201);
    const { orderId, accessToken } = res.body as {
      orderId: string;
      accessToken: string;
    };
    await request(apps.a.getHttpServer())
      .get(`/api/v1/orders/${orderId}?accessToken=${accessToken}`)
      .expect(200);
    const foreign = await request(apps.b.getHttpServer()).get(
      `/api/v1/orders/${orderId}?accessToken=${accessToken}`,
    );
    const absent = await request(apps.b.getHttpServer()).get(
      `/api/v1/orders/${randomUUID()}?accessToken=${accessToken}`,
    );
    expect([foreign.status, foreign.body]).toEqual([404, absent.body]);
    // A wrong token on the right storefront reads the same as well.
    const wrong = await request(apps.a.getHttpServer()).get(
      `/api/v1/orders/${orderId}?accessToken=${randomUUID()}`,
    );
    expect([wrong.status, wrong.body]).toEqual([404, absent.body]);
  });

  it("a customer can never read or reorder another business's order", async () => {
    const res = await checkout(
      'a',
      { locationId: F.a.locationId, lines: line(F.a) },
      'a',
    ).expect(201);
    const { orderId } = res.body as { orderId: string };
    const asB = (method: 'get' | 'post', path: string) =>
      request(apps.b.getHttpServer())
        [method](`/api/v1${path}`)
        .set('Authorization', `Bearer ${customerToken('b')}`);
    const list = await asB('get', '/customers/me/orders').expect(200);
    expect(JSON.stringify(list.body)).not.toContain(orderId);
    const foreign = await asB('get', `/customers/me/orders/${orderId}`);
    const absent = await asB('get', `/customers/me/orders/${randomUUID()}`);
    expect([foreign.status, foreign.body]).toEqual([404, absent.body]);
    const reorder = await asB(
      'post',
      `/customers/me/orders/${orderId}/reorder`,
    );
    expect(reorder.status).toBe(404);
    // And B's customer is not a customer of A's storefront at all.
    await request(apps.a.getHttpServer())
      .get('/api/v1/customers/me/orders')
      .set('Authorization', `Bearer ${customerToken('b')}`)
      .expect(403);
  });
});
