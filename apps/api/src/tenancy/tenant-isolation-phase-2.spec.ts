import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  INTERNAL_PERMISSION_KEYS,
  type CheckoutQuoteResponse,
} from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisModule } from '../redis/redis.module';
import { TenancyModule } from './tenancy.module';
import { LocationsModule } from '../locations/locations.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { CustomersModule } from '../customers/customers.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';
import { PaymentModule } from '../payment/payment.module';
import { MarketingModule } from '../marketing/marketing.module';
import { ApprovalsModule } from '../approvals/approvals.module';
import { MediaModule } from '../media/media.module';
import { CmsModule } from '../cms/cms.module';
import { OrdersController } from '../orders/api/orders.controller';
import { CheckoutService } from '../orders/application/checkout.service';

// Security Phase 2 — tenant isolation of the business-owned commercial data
// (promotions and coupons, loyalty rewards / bonus promotions / settings /
// ledger, gift cards and their transactions, marketing campaigns and
// approvals, the media library, CMS content) plus tenant-scoped uniqueness.
//
//   Tenant A = Tenant #1 (Mocha House) — also the storefront's business
//   Tenant B = the test-only isolation tenant
//
// Both businesses get their own staff, customers, catalog and financial
// records, deliberately sharing names, slugs and codes. Every admin request
// goes through InternalAuthGuard (the tenant is the server-validated active
// business); every storefront request goes through TenancyModule's
// deployment resolution (Tenant A).
describe('Tenant isolation phase 2 (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'tenant-isolation-phase-2-spec-secret';
  const suffix = randomUUID().slice(0, 8);

  const TENANT_A = TENANT_1_MOCHA_HOUSE_ID;
  const TENANT_B = TEST_TENANT_B_ID;

  // Everything Tenant A gets is tracked for removal; Tenant B is removed by
  // tenantId wholesale in afterAll.
  const userIdsA: string[] = [];
  const roleIdsA: string[] = [];
  const created = {
    promotions: [] as string[],
    rewards: [] as string[],
    bonusPromotions: [] as string[],
    giftCards: [] as string[],
    campaigns: [] as string[],
    approvals: [] as string[],
    media: [] as string[],
  };
  let loyaltyConfigA: { earningRatePerDollar: number } | null;
  let giftCardConfigA: {
    presetAmountsMinorUnits: number[];
    customAmountEnabled: boolean;
  } | null;

  type Fixtures = {
    locationId: string;
    categoryId: string;
    productId: string;
    menuId: string;
    customerId: string;
  };
  let A: Fixtures;
  let B: Fixtures;
  let mediaA: string;
  let mediaB: string;

  const subjectOf = (key: string) => `internal-dev:tip2-${key}-${suffix}`;
  const token = (key: string) =>
    signInternalDevJwt(
      {
        sub: subjectOf(key),
        email: `tip2-${key}-${suffix}@example.com`,
        name: null,
      },
      internalSecret,
      3600,
    );

  async function member(
    key: string,
    tenantId: string,
    permissions: readonly string[],
    scope: { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null } = {
      scopeType: 'CORPORATE',
      scopeId: null,
    },
  ): Promise<string> {
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: subjectOf(key),
        email: `tip2-${key}-${suffix}@example.com`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    const role = await prisma.internalRole.create({
      data: {
        tenantId,
        key: `tip2-${key}-${randomUUID()}`,
        displayName: 'Tenant isolation phase 2 spec role',
        permissions: {
          create: permissions.map((permissionKey) => ({
            permissionKey,
            tenantId,
          })),
        },
      },
    });
    if (tenantId === TENANT_A) {
      userIdsA.push(user.id);
      roleIdsA.push(role.id);
    }
    await prisma.internalUserRoleAssignment.create({
      data: { tenantId, internalUserId: user.id, roleId: role.id, ...scope },
    });
    return user.id;
  }

  // Both businesses get IDENTICAL slugs: per-tenant uniqueness must let
  // them coexist.
  async function fixturesFor(tenantId: string, tag: string): Promise<Fixtures> {
    const location = await prisma.location.create({
      data: { tenantId, name: `TIP2 ${tag}`, slug: `tip2-loc-${suffix}` },
    });
    const category = await prisma.category.create({
      data: { tenantId, name: `TIP2 Cat`, slug: `tip2-cat-${suffix}` },
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `TIP2 Latte`,
        slug: `tip2-latte-${suffix}`,
        categoryId: category.id,
        basePrice: 1000,
      },
    });
    const menu = await prisma.menu.create({
      data: { tenantId, name: `TIP2 Menu`, slug: `tip2-menu-${suffix}` },
    });
    await prisma.menuProduct.create({
      data: { tenantId, menuId: menu.id, productId: product.id },
    });
    await prisma.locationMenu.create({
      data: { tenantId, locationId: location.id, menuId: menu.id },
    });
    const customer = await prisma.customer.create({
      data: {
        tenantId,
        externalProvider: 'dev',
        externalSubject: `dev:tip2-${tag}-${suffix}`,
        email: `tip2-${tag}-${suffix}@example.test`,
        displayName: `TIP2 ${tag}`,
      },
    });
    await prisma.customerLoyaltyAccount.create({
      data: { tenantId, customerId: customer.id, balance: 100 },
    });
    return {
      locationId: location.id,
      categoryId: category.id,
      productId: product.id,
      menuId: menu.id,
      customerId: customer.id,
    };
  }

  async function mediaFor(tenantId: string, uploaderId: string) {
    const asset = await prisma.mediaAsset.create({
      data: {
        tenantId,
        objectKey: `tip2/${randomUUID()}.jpg`,
        fileName: 'tip2.jpg',
        contentType: 'image/jpeg',
        fileSizeBytes: 10,
        title: `TIP2 image ${suffix}`,
        uploadedByInternalUserId: uploaderId,
      },
    });
    return asset.id;
  }

  const http = () => request(app.getHttpServer());
  const admin = (
    method: 'get' | 'post' | 'patch' | 'put',
    key: string,
    tenantId: string,
    path: string,
    body?: object,
  ) => {
    const req = http()
      [method](`/api/v1/admin${path}`)
      .set('Authorization', `Bearer ${token(key)}`)
      .set('X-Tenant-Id', tenantId);
    return body === undefined ? req : req.send(body);
  };
  const quote = (body: object) =>
    http().post('/api/v1/orders/checkout-quote').send(body);
  const quoteFor = (locationId: string, productId: string, extra = {}) =>
    quote({
      locationId,
      lines: [{ productId, quantity: 1, selections: [] }],
      ...extra,
    });

  type Row = { id: string };
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;
  const ids = (rows: Row[]) => rows.map((row) => row.id);

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.SINGLE_TENANT_ID = TENANT_A;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        RedisModule,
        TenancyModule,
        LocationsModule,
        CustomerAuthModule,
        InternalAuthModule,
        CustomersModule,
        LoyaltyModule,
        PromotionsModule,
        GiftCardsModule,
        PaymentModule,
        MarketingModule,
        ApprovalsModule,
        MediaModule,
        CmsModule,
      ],
      controllers: [OrdersController],
      providers: [CheckoutService],
    }).compile();
    app = moduleFixture.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);

    await createTestTenantB(prisma);
    const all = INTERNAL_PERMISSION_KEYS;
    const adminA = await member('a-admin', TENANT_A, all);
    await member('a-approver', TENANT_A, all);
    const adminB = await member('b-admin', TENANT_B, all);
    // One verified human who administers BOTH businesses.
    await member('multi', TENANT_A, all);
    await member('multi', TENANT_B, all);

    A = await fixturesFor(TENANT_A, 'a');
    B = await fixturesFor(TENANT_B, 'b');
    // Gift-card / loyalty / promotions grants are CORPORATE-only: held at
    // LOCATION scope they must not open the commercial admin surface.
    await member(
      'a-location',
      TENANT_A,
      [
        'giftcards.view',
        'giftcards.manage',
        'promotions.configure',
        'loyalty.configure',
        'marketing.manage',
      ],
      { scopeType: 'LOCATION', scopeId: A.locationId },
    );
    mediaA = await mediaFor(TENANT_A, adminA);
    mediaB = await mediaFor(TENANT_B, adminB);
    created.media.push(mediaA);

    loyaltyConfigA = await prisma.loyaltyConfiguration.findUnique({
      where: { tenantId_key: { tenantId: TENANT_A, key: 'company' } },
      select: { earningRatePerDollar: true },
    });
    giftCardConfigA = await prisma.giftCardConfiguration.findUnique({
      where: { tenantId_key: { tenantId: TENANT_A, key: 'company' } },
      select: { presetAmountsMinorUnits: true, customAmountEnabled: true },
    });
  });

  afterAll(async () => {
    try {
      await removeSpecData();
    } finally {
      await app.close();
      process.env = { ...originalEnv };
    }
  });

  async function removeSpecData() {
    // A failed isolation assertion can leave a Tenant A row pointing at a
    // Tenant B record; detach those first so cleanup always completes.
    if (B) {
      for (const model of [
        prisma.promotionProduct,
        prisma.loyaltyRewardProduct,
        prisma.loyaltyBonusPromotionProduct,
        prisma.campaignProduct,
      ] as unknown as Array<{ deleteMany(args: object): Promise<unknown> }>) {
        await model.deleteMany({ where: { productId: B.productId } });
      }
      await prisma.promotionCategory.deleteMany({
        where: { categoryId: B.categoryId },
      });
      await prisma.loyaltyRewardCategory.deleteMany({
        where: { categoryId: B.categoryId },
      });
      await prisma.promotionLocation.deleteMany({
        where: { locationId: B.locationId },
      });
      await prisma.loyaltyBonusPromotionLocation.deleteMany({
        where: { locationId: B.locationId },
      });
    }

    // --- Tenant A: only what this spec created -------------------------
    const actorsA = { actorInternalUserId: { in: userIdsA } };
    await prisma.internalAuditEvent.deleteMany({ where: actorsA });
    await prisma.approvalRequest.deleteMany({
      where: { id: { in: created.approvals } },
    });
    await prisma.campaignProduct.deleteMany({
      where: { campaignId: { in: created.campaigns } },
    });
    await prisma.campaign.deleteMany({
      where: { id: { in: created.campaigns } },
    });
    await prisma.mediaAsset.deleteMany({
      where: { id: { in: created.media } },
    });
    await prisma.giftCardTransaction.deleteMany({
      where: { giftCardId: { in: created.giftCards } },
    });
    await prisma.giftCard.deleteMany({
      where: { id: { in: created.giftCards } },
    });
    for (const model of [
      prisma.promotionProduct,
      prisma.promotionCategory,
      prisma.promotionLocation,
    ] as unknown as Array<{
      deleteMany(args: object): Promise<unknown>;
    }>) {
      await model.deleteMany({
        where: { promotionId: { in: created.promotions } },
      });
    }
    await prisma.promotion.deleteMany({
      where: { id: { in: created.promotions } },
    });
    await prisma.loyaltyRewardProduct.deleteMany({
      where: { rewardId: { in: created.rewards } },
    });
    await prisma.loyaltyRewardCategory.deleteMany({
      where: { rewardId: { in: created.rewards } },
    });
    await prisma.loyaltyReward.deleteMany({
      where: { id: { in: created.rewards } },
    });
    await prisma.loyaltyBonusPromotionProduct.deleteMany({
      where: { promotionId: { in: created.bonusPromotions } },
    });
    await prisma.loyaltyBonusPromotionLocation.deleteMany({
      where: { promotionId: { in: created.bonusPromotions } },
    });
    await prisma.loyaltyBonusPromotion.deleteMany({
      where: { id: { in: created.bonusPromotions } },
    });
    if (A) {
      await prisma.mochaBeanLedgerEntry.deleteMany({
        where: { loyaltyAccount: { customerId: A.customerId } },
      });
      await prisma.customerLoyaltyAccount.deleteMany({
        where: { customerId: A.customerId },
      });
      await prisma.customer.deleteMany({ where: { id: A.customerId } });
      await prisma.locationMenu.deleteMany({ where: { menuId: A.menuId } });
      await prisma.menuProduct.deleteMany({ where: { menuId: A.menuId } });
      await prisma.menu.deleteMany({ where: { id: A.menuId } });
      await prisma.product.deleteMany({ where: { id: A.productId } });
      await prisma.category.deleteMany({ where: { id: A.categoryId } });
      await prisma.location.deleteMany({ where: { id: A.locationId } });
    }
    if (loyaltyConfigA) {
      await prisma.loyaltyConfiguration.update({
        where: { tenantId_key: { tenantId: TENANT_A, key: 'company' } },
        data: loyaltyConfigA,
      });
    }
    if (giftCardConfigA) {
      await prisma.giftCardConfiguration.update({
        where: { tenantId_key: { tenantId: TENANT_A, key: 'company' } },
        data: giftCardConfigA,
      });
    }
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIdsA } },
    });
    await prisma.internalRolePermission.deleteMany({
      where: { roleId: { in: roleIdsA } },
    });
    await prisma.internalRole.deleteMany({ where: { id: { in: roleIdsA } } });
    await prisma.internalUser.deleteMany({ where: { id: { in: userIdsA } } });

    // --- Tenant B: everything it owns, children first -------------------
    const ownedByB = { where: { tenantId: TENANT_B } };
    for (const model of [
      prisma.internalAuditEvent,
      prisma.approvalRequest,
      prisma.campaignProduct,
      prisma.campaign,
      prisma.mediaAsset,
      prisma.cmsPage,
      prisma.giftCardTransaction,
      prisma.giftCard,
      prisma.giftCardConfiguration,
      prisma.loyaltyConfiguration,
      prisma.mochaBeanLedgerEntry,
      prisma.customerLoyaltyAccount,
      prisma.customer,
      prisma.promotionProduct,
      prisma.promotionCategory,
      prisma.promotionLocation,
      prisma.promotion,
      prisma.loyaltyRewardProduct,
      prisma.loyaltyRewardCategory,
      prisma.loyaltyReward,
      prisma.loyaltyBonusPromotionProduct,
      prisma.loyaltyBonusPromotionLocation,
      prisma.loyaltyBonusPromotion,
      prisma.locationMenu,
      prisma.menuProduct,
      prisma.menu,
      prisma.product,
      prisma.category,
      prisma.location,
      prisma.internalUserRoleAssignment,
      prisma.internalRolePermission,
      prisma.internalRole,
      prisma.internalUser,
    ] as unknown as Array<{ deleteMany(args: object): Promise<unknown> }>) {
      await model.deleteMany(ownedByB);
    }
    await removeTestTenantB(prisma);
  }

  // --- (1) tenant-scoped uniqueness ---------------------------------------

  it('(1) identical catalog slugs coexist across businesses but stay unique within one', async () => {
    // fixturesFor gave both businesses the same Location/Category/Product/
    // Menu slugs; a second copy inside one business is still refused.
    await expect(
      prisma.product.create({
        data: {
          tenantId: TENANT_B,
          name: 'dup',
          slug: `tip2-latte-${suffix}`,
          categoryId: B.categoryId,
          basePrice: 1,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('(1b) every phase-2 table refuses a row without a business', async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "Promotion" (id, name, kind, "discountType", "updatedAt") VALUES (gen_random_uuid(), 'x', 'AUTOMATIC', 'PERCENTAGE_OFF', now())`,
      ),
    ).rejects.toThrow(/tenantId/);
    const nullable = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'tenantId'
        AND is_nullable = 'YES'`;
    expect(nullable).toEqual([]);
  });

  // --- (2) promotions and coupons -----------------------------------------

  const coupon = (code: string, name: string) => ({
    name,
    kind: 'COUPON',
    code,
    discountType: 'FIXED_AMOUNT',
    discountValue: 300,
    appliesToAllLocations: true,
  });
  const couponCode = `TIP2${suffix}`.toUpperCase();
  let couponA: string;
  let couponB: string;

  it('(2) the same coupon code can exist in both businesses, but not twice in one', async () => {
    const a = await admin(
      'post',
      'a-admin',
      TENANT_A,
      '/promotions',
      coupon(couponCode, `TIP2 A coupon ${suffix}`),
    ).expect(201);
    couponA = bodyOf<Row>(a).id;
    created.promotions.push(couponA);
    const b = await admin(
      'post',
      'b-admin',
      TENANT_B,
      '/promotions',
      coupon(couponCode, `TIP2 B coupon ${suffix}`),
    ).expect(201);
    couponB = bodyOf<Row>(b).id;

    await admin(
      'post',
      'b-admin',
      TENANT_B,
      '/promotions',
      coupon(couponCode, 'dup'),
    ).expect(409);

    expect(
      (await prisma.promotion.findUniqueOrThrow({ where: { id: couponA } }))
        .tenantId,
    ).toBe(TENANT_A);
    expect(
      (await prisma.promotion.findUniqueOrThrow({ where: { id: couponB } }))
        .tenantId,
    ).toBe(TENANT_B);
  });

  it('(2b) promotions are listed, edited and linked only inside their business', async () => {
    const listA = await admin('get', 'a-admin', TENANT_A, '/promotions').expect(
      200,
    );
    const rowsA = ids(bodyOf<{ promotions: Row[] }>(listA).promotions);
    expect(rowsA).toContain(couponA);
    expect(rowsA).not.toContain(couponB);

    // Editing the other business's promotion reads exactly like a missing one.
    const foreign = await admin(
      'patch',
      'a-admin',
      TENANT_A,
      `/promotions/${couponB}`,
      { name: 'hijacked' },
    );
    const missing = await admin(
      'patch',
      'a-admin',
      TENANT_A,
      `/promotions/${randomUUID()}`,
      { name: 'hijacked' },
    );
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
    expect(
      (await prisma.promotion.findUniqueOrThrow({ where: { id: couponB } }))
        .name,
    ).toBe(`TIP2 B coupon ${suffix}`);

    // A promotion cannot target the other business's products or locations.
    await admin('post', 'a-admin', TENANT_A, '/promotions', {
      ...coupon(`X${couponCode}`, 'x'),
      applicability: 'SELECTED_PRODUCTS',
      eligibleProductIds: [B.productId],
    }).expect(400);
    await admin('post', 'a-admin', TENANT_A, '/promotions', {
      ...coupon(`Y${couponCode}`, 'y'),
      appliesToAllLocations: false,
      eligibleLocationIds: [B.locationId],
    }).expect(400);

    // Options offer only the business's own catalog.
    const options = await admin(
      'get',
      'a-admin',
      TENANT_A,
      '/promotions/options',
    ).expect(200);
    const text = JSON.stringify(options.body);
    expect(text).toContain(A.productId);
    expect(text).not.toContain(B.productId);
    expect(text).not.toContain(B.locationId);
  });

  // --- (3) storefront checkout pricing --------------------------------------

  it("(3) the storefront never applies the other business's coupons, automatic promotions or locations", async () => {
    // Business B runs a generous automatic promotion everywhere.
    const auto = await admin('post', 'b-admin', TENANT_B, '/promotions', {
      name: `TIP2 B automatic ${suffix}`,
      kind: 'AUTOMATIC',
      discountType: 'PERCENTAGE_OFF',
      discountValue: 50,
      appliesToAllLocations: true,
    }).expect(201);
    expect(bodyOf<Row>(auto).id).toBeDefined();

    const plain = bodyOf<CheckoutQuoteResponse>(
      await quoteFor(A.locationId, A.productId).expect(200),
    );
    expect(plain.regularDiscount?.name ?? null).not.toBe(
      `TIP2 B automatic ${suffix}`,
    );

    // The shared code resolves to A's coupon (300 off), never B's.
    const withCoupon = bodyOf<CheckoutQuoteResponse>(
      await quoteFor(A.locationId, A.productId, { couponCode }).expect(200),
    );
    expect(withCoupon.couponStatus).toBe('applied');
    expect(withCoupon.regularDiscount?.name).toBe(`TIP2 A coupon ${suffix}`);

    // Deactivate A's copy: the code must now be invalid, not fall through
    // to B's still-active coupon.
    await admin('patch', 'a-admin', TENANT_A, `/promotions/${couponA}`, {
      isActive: false,
    }).expect(200);
    const afterDeactivate = bodyOf<CheckoutQuoteResponse>(
      await quoteFor(A.locationId, A.productId, { couponCode }).expect(200),
    );
    expect(afterDeactivate.couponStatus).not.toBe('applied');
    expect(afterDeactivate.regularDiscount?.name ?? null).not.toBe(
      `TIP2 B coupon ${suffix}`,
    );

    // B's location is not this storefront's: same as a missing location.
    const foreign = await quoteFor(B.locationId, B.productId);
    const missing = await quoteFor(randomUUID(), B.productId);
    expect(foreign.status).toBe(404);
    expect(foreign.body).toEqual(missing.body);
  });

  // --- (4) loyalty rewards, bonus promotions, settings, ledger -----------

  it('(4) rewards and bonus promotions stay inside their business', async () => {
    const reward = (name: string) => ({
      name,
      type: 'FIXED_AMOUNT',
      beanCost: 1,
      fixedAmountMinorUnits: 100,
    });
    const rA = await admin(
      'post',
      'a-admin',
      TENANT_A,
      '/loyalty/rewards',
      reward(`TIP2 reward ${suffix}`),
    ).expect(201);
    created.rewards.push(bodyOf<Row>(rA).id);
    const rB = await admin(
      'post',
      'b-admin',
      TENANT_B,
      '/loyalty/rewards',
      reward(`TIP2 reward ${suffix}`),
    ).expect(201);
    const rewardB = bodyOf<Row>(rB).id;

    const listA = await admin(
      'get',
      'a-admin',
      TENANT_A,
      '/loyalty/rewards',
    ).expect(200);
    expect(ids(bodyOf<{ rewards: Row[] }>(listA).rewards)).not.toContain(
      rewardB,
    );
    await admin('patch', 'a-admin', TENANT_A, `/loyalty/rewards/${rewardB}`, {
      beanCost: 999,
    }).expect(404);
    expect(
      (await prisma.loyaltyReward.findUniqueOrThrow({ where: { id: rewardB } }))
        .beanCost,
    ).toBe(1);
    await admin('post', 'a-admin', TENANT_A, '/loyalty/rewards', {
      ...reward('x'),
      type: 'FREE_ITEM',
      fixedAmountMinorUnits: null,
      eligibleProductIds: [B.productId],
    }).expect(400);

    // The storefront offers a customer only their own business's rewards.
    const offered = await prisma.loyaltyReward.findMany({
      where: { tenantId: TENANT_A, id: rewardB },
    });
    expect(offered).toEqual([]);

    const bonus = (name: string, productId: string) => ({
      name,
      type: 'EXTRA_BEANS',
      bonusValue: 20,
      eligibleProductIds: [productId],
      appliesToAllLocations: true,
    });
    const bA = await admin(
      'post',
      'a-admin',
      TENANT_A,
      '/loyalty/bonus-promotions',
      bonus(`TIP2 bonus ${suffix}`, A.productId),
    ).expect(201);
    created.bonusPromotions.push(bodyOf<Row>(bA).id);
    const bB = await admin(
      'post',
      'b-admin',
      TENANT_B,
      '/loyalty/bonus-promotions',
      bonus(`TIP2 bonus ${suffix}`, B.productId),
    ).expect(201);
    const bonusB = bodyOf<Row>(bB).id;
    await admin(
      'post',
      'a-admin',
      TENANT_A,
      '/loyalty/bonus-promotions',
      bonus('x', B.productId),
    ).expect(400);
    const bonusList = await admin(
      'get',
      'a-admin',
      TENANT_A,
      '/loyalty/bonus-promotions',
    ).expect(200);
    expect(
      ids(bodyOf<{ promotions: Row[] }>(bonusList).promotions),
    ).not.toContain(bonusB);
    await admin(
      'patch',
      'a-admin',
      TENANT_A,
      `/loyalty/bonus-promotions/${bonusB}`,
      { isActive: false },
    ).expect(404);
    expect(
      (
        await prisma.loyaltyBonusPromotion.findUniqueOrThrow({
          where: { id: bonusB },
        })
      ).isActive,
    ).toBe(true);
  });

  it('(4b) loyalty and gift-card settings are independent per business', async () => {
    await admin('put', 'b-admin', TENANT_B, '/loyalty/settings', {
      earningRatePerDollar: 7,
    }).expect(200);
    await admin('put', 'a-admin', TENANT_A, '/loyalty/settings', {
      earningRatePerDollar: 3,
    }).expect(200);
    const a = await admin('get', 'a-admin', TENANT_A, '/loyalty/settings');
    const b = await admin('get', 'b-admin', TENANT_B, '/loyalty/settings');
    expect(
      bodyOf<{ earningRatePerDollar: number }>(a).earningRatePerDollar,
    ).toBe(3);
    expect(
      bodyOf<{ earningRatePerDollar: number }>(b).earningRatePerDollar,
    ).toBe(7);

    await admin('put', 'b-admin', TENANT_B, '/gift-cards/configuration', {
      presetAmountsMinorUnits: [700],
      customAmountEnabled: false,
    }).expect(200);
    const gA = await admin(
      'get',
      'a-admin',
      TENANT_A,
      '/gift-cards/configuration',
    ).expect(200);
    expect(
      bodyOf<{ presetAmountsMinorUnits: number[] }>(gA).presetAmountsMinorUnits,
    ).not.toEqual([700]);
    // The storefront (Tenant A) still offers A's amounts.
    const publicOptions = await http()
      .get('/api/v1/gift-cards/purchase-options')
      .expect(200);
    expect(JSON.stringify(publicOptions.body)).not.toMatch(/\b700\b/);
  });

  it('(4c) loyalty adjustments use per-business idempotency and never touch the other ledger', async () => {
    const operationKey = `tip2-op-${suffix}`;
    const adjust = (key: string, tenantId: string, customerId: string) =>
      admin(
        'post',
        key,
        tenantId,
        `/loyalty/customers/${customerId}/adjustments`,
        { deltaBeans: 5, reason: 'TIP2', operationKey },
      );
    expect(
      (await adjust('a-admin', TENANT_A, A.customerId)).status,
    ).toBeLessThan(300);
    expect(
      (await adjust('b-admin', TENANT_B, B.customerId)).status,
    ).toBeLessThan(300);
    // A cannot adjust B's customer (foreign = missing), with any key.
    expect((await adjust('a-admin', TENANT_A, B.customerId)).status).toBe(404);

    for (const [f, tenantId] of [
      [A, TENANT_A],
      [B, TENANT_B],
    ] as const) {
      const account = await prisma.customerLoyaltyAccount.findUniqueOrThrow({
        where: { customerId: f.customerId },
        include: { entries: true },
      });
      expect(account.balance).toBe(105);
      expect(account.entries).toHaveLength(1);
      expect(account.entries[0].tenantId).toBe(tenantId);
    }
  });

  // --- (5) gift cards ------------------------------------------------------

  it('(5) gift cards: no cross-business search, read, status change or correction; balances intact', async () => {
    const issue = async (key: string, tenantId: string) => {
      const res = await admin('post', key, tenantId, '/gift-cards', {
        originalValueMinorUnits: 2500,
      }).expect(201);
      return bodyOf<{ giftCard: Row; code: string }>(res);
    };
    const cardA = await issue('a-admin', TENANT_A);
    created.giftCards.push(cardA.giftCard.id);
    const cardB = await issue('b-admin', TENANT_B);

    // B cannot find A's card by its code or id.
    for (const body of [
      { code: cardA.code },
      { giftCardId: cardA.giftCard.id },
    ]) {
      const res = await admin(
        'post',
        'b-admin',
        TENANT_B,
        '/gift-cards/search',
        body,
      );
      expect(res.status).toBeLessThan(300);
      expect(bodyOf<{ giftCards: Row[] }>(res).giftCards).toEqual([]);
    }
    await admin(
      'get',
      'b-admin',
      TENANT_B,
      `/gift-cards/${cardA.giftCard.id}`,
    ).expect(404);
    await admin(
      'post',
      'b-admin',
      TENANT_B,
      `/gift-cards/${cardA.giftCard.id}/deactivate`,
      {},
    ).expect(404);
    await admin(
      'post',
      'b-admin',
      TENANT_B,
      `/gift-cards/${cardA.giftCard.id}/corrections`,
      {
        deltaMinorUnits: -2500,
        reason: 'steal',
        operationKey: `tip2-gc-${suffix}`,
      },
    ).expect(404);

    const untouched = await prisma.giftCard.findUniqueOrThrow({
      where: { id: cardA.giftCard.id },
      include: { transactions: true },
    });
    expect(untouched.status).toBe('ACTIVE');
    expect(untouched.balanceMinorUnits).toBe(2500);
    expect(untouched.transactions.map((t) => t.type)).toEqual(['ISSUANCE']);
    expect(untouched.transactions[0].tenantId).toBe(TENANT_A);

    // A's own correction works and is recorded in A.
    await admin(
      'post',
      'a-admin',
      TENANT_A,
      `/gift-cards/${cardA.giftCard.id}/corrections`,
      {
        deltaMinorUnits: -500,
        reason: 'TIP2 fix',
        operationKey: `tip2-gc-${suffix}`,
      },
    ).expect(201);
    const corrected = await prisma.giftCard.findUniqueOrThrow({
      where: { id: cardA.giftCard.id },
      include: { transactions: { orderBy: { createdAt: 'asc' } } },
    });
    expect(corrected.balanceMinorUnits).toBe(2000);
    expect(corrected.transactions.map((t) => [t.type, t.tenantId])).toEqual([
      ['ISSUANCE', TENANT_A],
      ['ADJUSTMENT', TENANT_A],
    ]);
    const sum = corrected.transactions.reduce(
      (total, t) => total + t.amountMinorUnits,
      0,
    );
    expect(sum).toBe(corrected.balanceMinorUnits);

    // Storefront (Tenant A): B's card is not a card here at all.
    const balanceB = await http()
      .post('/api/v1/gift-cards/balance')
      .send({ code: cardB.code })
      .expect(200);
    expect(balanceB.body).toEqual({ found: false });
    const balanceA = await http()
      .post('/api/v1/gift-cards/balance')
      .send({ code: cardA.code })
      .expect(200);
    expect(
      bodyOf<{ balanceMinorUnits: number }>(balanceA).balanceMinorUnits,
    ).toBe(2000);

    const quoteB = bodyOf<CheckoutQuoteResponse>(
      await quoteFor(A.locationId, A.productId, {
        giftCardCode: cardB.code,
      }).expect(200),
    );
    expect(quoteB.giftCardStatus).toBe('not_found');
    const quoteA = bodyOf<CheckoutQuoteResponse>(
      await quoteFor(A.locationId, A.productId, {
        giftCardCode: cardA.code,
      }).expect(200),
    );
    expect(quoteA.giftCardStatus).toBe('applied');

    // B's card is unchanged by everything above.
    const cardBRow = await prisma.giftCard.findUniqueOrThrow({
      where: { id: cardB.giftCard.id },
    });
    expect([cardBRow.tenantId, cardBRow.balanceMinorUnits]).toEqual([
      TENANT_B,
      2500,
    ]);
  });

  // --- (6) marketing, approvals, media ------------------------------------

  it('(6) campaigns, approvals and media never cross businesses', async () => {
    // B cannot attach A's image (or A's promotion) to its campaign.
    await admin('post', 'b-admin', TENANT_B, '/marketing/campaigns', {
      name: 'x',
      mediaAssetId: mediaA,
    }).expect(400);
    await admin('post', 'b-admin', TENANT_B, '/marketing/campaigns', {
      name: 'x',
      promotionId: couponA,
    }).expect(400);
    await admin('post', 'b-admin', TENANT_B, '/marketing/campaigns', {
      name: 'x',
      featuredProductIds: [A.productId],
    }).expect(400);

    const cA = await admin(
      'post',
      'a-admin',
      TENANT_A,
      '/marketing/campaigns',
      {
        name: `TIP2 campaign ${suffix}`,
        mediaAssetId: mediaA,
      },
    ).expect(201);
    const campaignA = bodyOf<Row>(cA).id;
    created.campaigns.push(campaignA);
    const cB = await admin(
      'post',
      'b-admin',
      TENANT_B,
      '/marketing/campaigns',
      {
        name: `TIP2 campaign ${suffix}`,
        mediaAssetId: mediaB,
      },
    ).expect(201);
    const campaignB = bodyOf<Row>(cB).id;

    const listB = await admin(
      'get',
      'b-admin',
      TENANT_B,
      '/marketing/campaigns',
    ).expect(200);
    const listedB = ids(bodyOf<{ campaigns: Row[] }>(listB).campaigns);
    expect(listedB).toContain(campaignB);
    expect(listedB).not.toContain(campaignA);
    await admin(
      'get',
      'b-admin',
      TENANT_B,
      `/marketing/campaigns/${campaignA}`,
    ).expect(404);
    await admin(
      'patch',
      'b-admin',
      TENANT_B,
      `/marketing/campaigns/${campaignA}`,
      {
        name: 'hijacked',
      },
    ).expect(404);
    await admin(
      'post',
      'b-admin',
      TENANT_B,
      `/marketing/campaigns/${campaignA}/request-approval`,
      {},
    ).expect(404);

    // A's approval request is A's alone.
    await admin(
      'post',
      'a-admin',
      TENANT_A,
      `/marketing/campaigns/${campaignA}/request-approval`,
      {},
    ).expect((res) => expect(res.status).toBeLessThan(300));
    const approval = await prisma.approvalRequest.findFirstOrThrow({
      where: { targetId: campaignA },
    });
    created.approvals.push(approval.id);
    expect(approval.tenantId).toBe(TENANT_A);

    const approvalsB = await admin(
      'get',
      'b-admin',
      TENANT_B,
      '/approvals',
    ).expect(200);
    expect(JSON.stringify(approvalsB.body)).not.toContain(approval.id);
    await admin('get', 'b-admin', TENANT_B, `/approvals/${approval.id}`).expect(
      404,
    );
    await admin(
      'post',
      'b-admin',
      TENANT_B,
      `/approvals/${approval.id}/approve`,
      {},
    ).expect(404);
    expect(
      (
        await prisma.approvalRequest.findUniqueOrThrow({
          where: { id: approval.id },
        })
      ).status,
    ).toBe('PENDING');
    expect(
      (await prisma.campaign.findUniqueOrThrow({ where: { id: campaignA } }))
        .name,
    ).toBe(`TIP2 campaign ${suffix}`);

    // Within A the workflow still works end to end.
    await admin(
      'post',
      'a-approver',
      TENANT_A,
      `/approvals/${approval.id}/approve`,
      {},
    ).expect((res) => expect(res.status).toBeLessThan(300));

    // Media library.
    const mediaListB = await admin('get', 'b-admin', TENANT_B, '/media').expect(
      200,
    );
    const listedMedia = ids(bodyOf<{ assets: Row[] }>(mediaListB).assets);
    expect(listedMedia).toContain(mediaB);
    expect(listedMedia).not.toContain(mediaA);
    await admin('get', 'b-admin', TENANT_B, `/media/${mediaA}`).expect(404);
    await admin('patch', 'b-admin', TENANT_B, `/media/${mediaA}`, {
      title: 'hijacked',
    }).expect(404);
    await admin(
      'post',
      'b-admin',
      TENANT_B,
      `/media/${mediaA}/deactivate`,
      {},
    ).expect(404);
    const assetA = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: mediaA },
    });
    expect([assetA.isActive, assetA.title]).toEqual([
      true,
      `TIP2 image ${suffix}`,
    ]);
  });

  // --- (7) CMS ---------------------------------------------------------------

  it("(7) a business's CMS draft is its own", async () => {
    const before = await admin(
      'get',
      'a-admin',
      TENANT_A,
      '/content/franchising',
    ).expect(200);
    const draftA = bodyOf<{
      draftContent: { intro: { heading: string } };
    }>(before).draftContent;
    const baseB = await admin(
      'get',
      'b-admin',
      TENANT_B,
      '/content/franchising',
    ).expect(200);
    const content = bodyOf<{ draftContent: { intro: object } }>(
      baseB,
    ).draftContent;
    await admin('patch', 'b-admin', TENANT_B, '/content/franchising', {
      content: {
        ...content,
        intro: { ...content.intro, heading: `TIP2 B heading ${suffix}` },
      },
    }).expect(200);

    const afterA = await admin(
      'get',
      'a-admin',
      TENANT_A,
      '/content/franchising',
    ).expect(200);
    expect(
      bodyOf<{ draftContent: { intro: { heading: string } } }>(afterA)
        .draftContent.intro.heading,
    ).toBe(draftA.intro.heading);
    const afterB = await admin(
      'get',
      'b-admin',
      TENANT_B,
      '/content/franchising',
    ).expect(200);
    expect(
      bodyOf<{ draftContent: { intro: { heading: string } } }>(afterB)
        .draftContent.intro.heading,
    ).toBe(`TIP2 B heading ${suffix}`);
    // The storefront (Tenant A) never serves B's content.
    const published = await http().get('/api/v1/content/franchising');
    expect(JSON.stringify(published.body)).not.toContain('TIP2 B heading');
  });

  // --- (8) audit ----------------------------------------------------------------

  it('(8) audit events are recorded in the acting business', async () => {
    const events = await prisma.internalAuditEvent.findMany({
      where: {
        actorInternalUser: {
          externalSubject: { startsWith: `internal-dev:tip2-` },
        },
        createdAt: { gte: new Date(Date.now() - 10 * 60_000) },
      },
      include: { actorInternalUser: { select: { tenantId: true } } },
    });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.tenantId).toBe(event.actorInternalUser.tenantId);
    }
    expect(new Set(events.map((e) => e.tenantId))).toEqual(
      new Set([TENANT_A, TENANT_B]),
    );
  });

  // --- (9) the business selection and permissions --------------------------

  it('(9) a person in two businesses sees and changes only the selected one', async () => {
    const inA = await admin('get', 'multi', TENANT_A, '/promotions').expect(
      200,
    );
    const inB = await admin('get', 'multi', TENANT_B, '/promotions').expect(
      200,
    );
    const rowsA = ids(bodyOf<{ promotions: Row[] }>(inA).promotions);
    const rowsB = ids(bodyOf<{ promotions: Row[] }>(inB).promotions);
    expect(rowsA).toContain(couponA);
    expect(rowsA).not.toContain(couponB);
    expect(rowsB).toContain(couponB);
    expect(rowsB).not.toContain(couponA);

    // Selected A: B's records are out of reach even for a B member.
    await admin('patch', 'multi', TENANT_A, `/promotions/${couponB}`, {
      name: 'cross',
    }).expect(404);
    await admin('get', 'multi', TENANT_A, `/media/${mediaB}`).expect(404);

    // The new record lands in the selected business only.
    const res = await admin('post', 'multi', TENANT_B, '/loyalty/rewards', {
      name: `TIP2 multi ${suffix}`,
      type: 'FIXED_AMOUNT',
      beanCost: 2,
      fixedAmountMinorUnits: 100,
    }).expect(201);
    expect(
      (
        await prisma.loyaltyReward.findUniqueOrThrow({
          where: { id: bodyOf<Row>(res).id },
        })
      ).tenantId,
    ).toBe(TENANT_B);
  });

  it('(9b) forged business ids are refused and permission checks still apply', async () => {
    for (const path of ['/promotions', '/gift-cards/configuration', '/media']) {
      await admin('get', 'a-admin', TENANT_B, path).expect(403);
      await admin('get', 'a-admin', 'not-a-uuid', path).expect(400);
    }
    await admin('post', 'a-admin', TENANT_B, '/gift-cards/search', {
      code: 'XXXX',
    }).expect(403);
    // CORPORATE-only grants held at LOCATION scope do not open these.
    await admin('post', 'a-location', TENANT_A, '/gift-cards/search', {
      code: 'XXXX',
    }).expect(403);
    await admin('get', 'a-location', TENANT_A, '/promotions').expect(403);
    await admin('get', 'a-location', TENANT_A, '/loyalty/settings').expect(403);
    await admin('post', 'a-location', TENANT_A, '/marketing/campaigns', {
      name: 'x',
    }).expect(403);
  });
});
