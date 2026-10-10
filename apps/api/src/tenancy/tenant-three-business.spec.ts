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
  TEST_TENANT_C_ID,
  createTestTenantB,
  createTestTenantC,
  removeTestTenantB,
  removeTestTenantC,
} from '@mocha-house/testing';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { resolveBusinessDate } from '../operations/application/business-date';
import { CareersPublicThrottleGuard } from '../careers/infrastructure/careers-public-throttle.guard';
import { FranchisingPublicThrottleGuard } from '../franchising/infrastructure/franchising-public-throttle.guard';
import { GiftCardPublicThrottleGuard } from '../gift-cards/infrastructure/gift-card-public-throttle.guard';

// Security 4B — three businesses sharing one database and the REAL
// AppModule (every route, every guard). Mocha House is just one of them:
// every ordered pair (A→B, A→C, B→A, B→C, C→A, C→B) is exercised, including
// the two pairs that do not involve Mocha House at all.
//
// For each actor business X and target business Y:
//   - lists, searches and reports of X contain none of Y's records;
//   - every detail / location route answers Y's id exactly like a
//     non-existent one;
//   - every write against Y's records answers exactly like a write against
//     a non-existent record, and Y's data is byte-for-byte unchanged
//     afterwards (snapshot of every Y-owned table);
//   - X cannot attach Y's products, locations, media or promotions to its
//     own records;
//   - X's storefront cannot see or use Y's catalog, locations, jobs, coupons
//     or gift cards.
// Identical names, slugs and coupon codes are used in all three businesses.

jest.setTimeout(300_000);

type Tag = 'a' | 'b' | 'c';
const TENANTS: Record<Tag, string> = {
  a: TENANT_1_MOCHA_HOUSE_ID,
  b: TEST_TENANT_B_ID,
  c: TEST_TENANT_C_ID,
};
const TAGS: Tag[] = ['a', 'b', 'c'];
const PAIRS: Array<[Tag, Tag]> = TAGS.flatMap((x) =>
  TAGS.filter((y) => y !== x).map((y) => [x, y] as [Tag, Tag]),
);

interface Fixtures {
  tenantId: string;
  adminId: string;
  locationId: string;
  categoryId: string;
  productId: string;
  menuId: string;
  modifierGroupId: string;
  customerId: string;
  customerEmail: string;
  jobId: string;
  applicationId: string;
  inquiryId: string;
  promotionId: string;
  rewardId: string;
  bonusId: string;
  campaignId: string;
  mediaId: string;
  taskId: string;
  orderId: string;
  giftCardId: string;
  giftCardCode: string;
}

describe('Three-business tenant isolation (integration)', () => {
  const apps = {} as Record<Tag, INestApplication<App>>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const secret = 'three-business-spec-secret';
  const suffix = randomUUID().slice(0, 8);
  const couponCode = `TBI${suffix}`.toUpperCase();
  const F = {} as Record<Tag, Fixtures>;
  const createdInA: { userIds: string[]; roleIds: string[] } = {
    userIds: [],
    roleIds: [],
  };

  const subject = (key: string) => `internal-dev:tbi-${key}-${suffix}`;
  const token = (key: string) =>
    signInternalDevJwt(
      {
        sub: subject(key),
        email: `tbi-${key}-${suffix}@example.test`,
        name: null,
      },
      secret,
      3600,
    );

  async function buildApp(tenantId: string) {
    process.env.SINGLE_TENANT_ID = tenantId;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideGuard(CareersPublicThrottleGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(FranchisingPublicThrottleGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(GiftCardPublicThrottleGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    return app;
  }

  async function member(
    key: string,
    tenantId: string,
    permissions: readonly string[],
  ): Promise<string> {
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: subject(key),
        email: `tbi-${key}-${suffix}@example.test`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    const role = await prisma.internalRole.create({
      data: {
        tenantId,
        key: `tbi-${randomUUID()}`,
        displayName: 'Three-business spec role',
        permissions: {
          create: permissions.map((permissionKey) => ({
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
    if (tenantId === TENANTS.a) {
      createdInA.userIds.push(user.id);
      createdInA.roleIds.push(role.id);
    }
    return user.id;
  }

  // Identical names and slugs in every business; only ownership differs.
  async function fixturesFor(
    tag: Tag,
  ): Promise<Omit<Fixtures, 'giftCardId' | 'giftCardCode'>> {
    const tenantId = TENANTS[tag];
    const adminId = await member(
      `${tag}-admin`,
      tenantId,
      INTERNAL_PERMISSION_KEYS,
    );
    const location = await prisma.location.create({
      data: {
        tenantId,
        name: 'TBI Main Street',
        slug: `tbi-main-${suffix}`,
        isDigitalOrderingEnabled: true,
      },
    });
    const category = await prisma.category.create({
      data: { tenantId, name: 'TBI Coffee', slug: `tbi-coffee-${suffix}` },
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: 'TBI Latte',
        slug: `tbi-latte-${suffix}`,
        categoryId: category.id,
        basePrice: 500,
      },
    });
    const menu = await prisma.menu.create({
      data: { tenantId, name: 'TBI Menu', slug: `tbi-menu-${suffix}` },
    });
    await prisma.menuProduct.create({
      data: { tenantId, menuId: menu.id, productId: product.id },
    });
    await prisma.locationMenu.create({
      data: { tenantId, locationId: location.id, menuId: menu.id },
    });
    const group = await prisma.modifierGroup.create({
      data: { tenantId, name: 'TBI Milk' },
    });
    await prisma.modifierOption.create({
      data: { tenantId, modifierGroupId: group.id, name: 'TBI Oat' },
    });
    await prisma.productModifierGroup.create({
      data: { tenantId, productId: product.id, modifierGroupId: group.id },
    });
    const customerEmail = `tbi-${tag}-customer-${suffix}@example.test`;
    const customer = await prisma.customer.create({
      data: {
        tenantId,
        externalProvider: 'dev',
        externalSubject: `dev:tbi-${tag}-${suffix}`,
        email: customerEmail,
      },
    });
    await prisma.customerLoyaltyAccount.create({
      data: { tenantId, customerId: customer.id, balance: 100 },
    });
    await prisma.customerNote.create({
      data: {
        tenantId,
        customerId: customer.id,
        authorInternalUserId: adminId,
        body: `TBI-${tag} note`,
      },
    });
    const job = await prisma.jobOpening.create({
      data: {
        tenantId,
        title: 'TBI Barista',
        employmentType: 'FULL_TIME',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        locationId: location.id,
        summary: 's',
        description: 'd',
        responsibilities: 'r',
        qualifications: 'q',
      },
    });
    const application = await prisma.jobApplication.create({
      data: {
        tenantId,
        jobOpeningId: job.id,
        jobTitleSnapshot: job.title,
        firstName: 'TBI',
        lastName: tag,
        email: `tbi-${tag}-applicant-${suffix}@example.test`,
        phone: '5550000000',
        location: 'Detroit, MI',
        workAuthorized: true,
        availability: 'any',
        message: 'hello',
      },
    });
    const inquiry = await prisma.franchiseInquiry.create({
      data: {
        tenantId,
        firstName: 'TBI',
        lastName: tag,
        email: `tbi-${tag}-prospect-${suffix}@example.test`,
        phone: '5550000001',
        city: 'Detroit',
        state: 'MI',
        country: 'US',
        preferredMarket: 'Detroit',
        consentAcknowledged: true,
      },
    });
    const promotion = await prisma.promotion.create({
      data: {
        tenantId,
        name: `TBI-${tag} coupon`,
        kind: 'COUPON',
        code: couponCode,
        discountType: 'FIXED_AMOUNT',
        discountValue: 100,
        appliesToAllLocations: true,
      },
    });
    const reward = await prisma.loyaltyReward.create({
      data: {
        tenantId,
        name: 'TBI reward',
        type: 'FIXED_AMOUNT',
        beanCost: 10,
        fixedAmountMinorUnits: 100,
      },
    });
    const bonus = await prisma.loyaltyBonusPromotion.create({
      data: { tenantId, name: 'TBI bonus', type: 'EXTRA_BEANS', bonusValue: 5 },
    });
    await prisma.loyaltyBonusPromotionProduct.create({
      data: { tenantId, promotionId: bonus.id, productId: product.id },
    });
    const media = await prisma.mediaAsset.create({
      data: {
        tenantId,
        objectKey: `tbi/${randomUUID()}.jpg`,
        fileName: 'tbi.jpg',
        contentType: 'image/jpeg',
        fileSizeBytes: 10,
        title: 'TBI image',
        uploadedByInternalUserId: adminId,
      },
    });
    const campaign = await prisma.campaign.create({
      data: { tenantId, name: 'TBI campaign', mediaAssetId: media.id },
    });
    const task = await prisma.operationsTask.create({
      data: {
        tenantId,
        locationId: location.id,
        title: 'TBI task',
        createdByInternalUserId: adminId,
        businessDate: new Date(
          `${resolveBusinessDate(new Date())}T00:00:00.000Z`,
        ),
      },
    });
    const attempt = await prisma.paymentAttempt.create({
      data: {
        tenantId,
        idempotencyKey: `tbi-${randomUUID()}`,
        provider: 'fake',
        status: 'SUCCEEDED',
        locationId: location.id,
        amount: 500,
        currency: 'USD',
      },
    });
    const order = await prisma.order.create({
      data: {
        tenantId,
        orderNumber: `TBI-${tag}-${randomUUID().slice(0, 8)}`,
        accessToken: randomUUID(),
        locationId: location.id,
        customerId: customer.id,
        paymentAttemptId: attempt.id,
        guestName: 'TBI',
        guestPhone: '5550000002',
        currency: 'USD',
        subtotal: 500,
        status: 'RECEIVED',
      },
    });
    return {
      tenantId,
      adminId,
      locationId: location.id,
      categoryId: category.id,
      productId: product.id,
      menuId: menu.id,
      modifierGroupId: group.id,
      customerId: customer.id,
      customerEmail,
      jobId: job.id,
      applicationId: application.id,
      inquiryId: inquiry.id,
      promotionId: promotion.id,
      rewardId: reward.id,
      bonusId: bonus.id,
      campaignId: campaign.id,
      mediaId: media.id,
      taskId: task.id,
      orderId: order.id,
    };
  }

  const ids = (f: Fixtures) =>
    (Object.entries(f) as Array<[keyof Fixtures, string]>)
      .filter(
        ([k]) =>
          k !== 'tenantId' && k !== 'customerEmail' && k !== 'giftCardCode',
      )
      .map(([, v]) => v);

  const admin = (
    tag: Tag,
    method: 'get' | 'post' | 'patch' | 'put',
    path: string,
    body?: object,
    key = `${tag}-admin`,
  ) => {
    const req = request(apps[tag].getHttpServer())
      [method](`/api/v1/admin${path}`)
      .set('Authorization', `Bearer ${token(key)}`)
      .set('X-Tenant-Id', TENANTS[tag]);
    return body === undefined ? req : req.send(body);
  };
  const store = (
    tag: Tag,
    method: 'get' | 'post',
    path: string,
    body?: object,
  ) => {
    const req = request(apps[tag].getHttpServer())[method](`/api/v1${path}`);
    return body === undefined ? req : req.send(body);
  };

  // Every row the business owns, in every business-owned table this suite
  // can reach, as a sorted list of JSON rows.
  const SNAPSHOT_MODELS = [
    'customer',
    'customerNote',
    'customerLoyaltyAccount',
    'mochaBeanLedgerEntry',
    'location',
    'category',
    'product',
    'menu',
    'menuProduct',
    'locationMenu',
    'locationProductPriceOverride',
    'modifierGroup',
    'jobOpening',
    'jobApplication',
    'jobApplicationNote',
    'franchiseInquiry',
    'franchiseInquiryNote',
    'promotion',
    'promotionProduct',
    'promotionLocation',
    'loyaltyReward',
    'loyaltyRewardProduct',
    'loyaltyBonusPromotion',
    'loyaltyBonusPromotionProduct',
    'giftCard',
    'giftCardTransaction',
    'campaign',
    'campaignProduct',
    'mediaAsset',
    'approvalRequest',
    'operationsTask',
    'order',
    'orderStatusHistory',
    'cmsPage',
    'internalUser',
    'internalUserRoleAssignment',
  ] as const;
  async function snapshot(tenantId: string): Promise<Record<string, string[]>> {
    const out: Record<string, string[]> = {};
    for (const model of SNAPSHOT_MODELS) {
      const delegate = (
        prisma as unknown as Record<
          string,
          { findMany(a: object): Promise<object[]> }
        >
      )[model];
      const rows = await delegate.findMany({ where: { tenantId } });
      out[model] = rows.map((r) => JSON.stringify(r)).sort();
    }
    return out;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = secret;
    apps.a = await buildApp(TENANTS.a);
    prisma = apps.a.get(PrismaService);
    await createTestTenantB(prisma);
    await createTestTenantC(prisma);
    apps.b = await buildApp(TENANTS.b);
    apps.c = await buildApp(TENANTS.c);
    for (const tag of TAGS) {
      const base = await fixturesFor(tag);
      // Gift cards are issued through the Admin API (the only place a code
      // is ever revealed).
      const issued = await request(apps[tag].getHttpServer())
        .post('/api/v1/admin/gift-cards')
        .set('Authorization', `Bearer ${token(`${tag}-admin`)}`)
        .set('X-Tenant-Id', TENANTS[tag])
        .send({ originalValueMinorUnits: 2500 })
        .expect(201);
      const body = issued.body as { giftCard: { id: string }; code: string };
      F[tag] = {
        ...base,
        giftCardId: body.giftCard.id,
        giftCardCode: body.code,
      };
    }
    // One person with access to two businesses that are NOT Mocha House:
    // everything in B, only catalog.view in C.
    await member('multi', TENANTS.b, INTERNAL_PERMISSION_KEYS);
    await member('multi', TENANTS.c, ['catalog.view']);
  });

  afterAll(async () => {
    try {
      // If an isolation regression ever let one business's staff write into
      // another business, those rows reference staff of the wrong business;
      // remove anything authored by this suite's staff first so cleanup can
      // never cascade into leftover data for later suites.
      const staff = (
        await prisma.internalUser.findMany({
          where: { externalSubject: { startsWith: 'internal-dev:tbi-' } },
          select: { id: true },
        })
      ).map((u) => u.id);
      for (const [model, field] of [
        ['customerNote', 'authorInternalUserId'],
        ['jobApplicationNote', 'authorInternalUserId'],
        ['franchiseInquiryNote', 'authorInternalUserId'],
        ['internalAuditEvent', 'actorInternalUserId'],
        ['operationsTask', 'createdByInternalUserId'],
        ['mediaAsset', 'uploadedByInternalUserId'],
        ['mochaBeanLedgerEntry', 'actorInternalUserId'],
        ['giftCardTransaction', 'actorInternalUserId'],
        ['approvalRequest', 'requestedByInternalUserId'],
      ] as const) {
        await (
          prisma as unknown as Record<
            string,
            { deleteMany(a: object): Promise<unknown> }
          >
        )[model].deleteMany({
          where: { [field]: { in: staff } },
        });
      }
      // Mocha House: only what this suite created there.
      const a = F.a;
      if (a) {
        const del = async (model: string, where: object) =>
          (
            prisma as unknown as Record<
              string,
              { deleteMany(a: object): Promise<unknown> }
            >
          )[model].deleteMany({ where });
        await del('internalAuditEvent', {
          actorInternalUserId: { in: createdInA.userIds },
        });
        await del('approvalRequest', { targetId: a.campaignId });
        await del('campaignProduct', { campaignId: a.campaignId });
        await del('campaign', {
          tenantId: TENANTS.a,
          name: { startsWith: 'TBI' },
        });
        await del('mediaAsset', {
          uploadedByInternalUserId: { in: createdInA.userIds },
        });
        await del('giftCardTransaction', { giftCardId: a.giftCardId });
        await del('giftCard', { id: a.giftCardId });
        await del('operationsTask', {
          createdByInternalUserId: { in: createdInA.userIds },
        });
        await del('orderStatusHistory', { orderId: a.orderId });
        await del('order', { id: a.orderId });
        await del('paymentAttempt', { locationId: a.locationId });
        await del('promotionProduct', { productId: a.productId });
        await del('promotionLocation', { locationId: a.locationId });
        await del('promotion', {
          tenantId: TENANTS.a,
          OR: [{ code: couponCode }, { name: { startsWith: 'TBI' } }],
        });
        await del('loyaltyRewardProduct', { productId: a.productId });
        await del('loyaltyReward', { id: a.rewardId });
        await del('loyaltyBonusPromotionProduct', { productId: a.productId });
        await del('loyaltyBonusPromotion', { id: a.bonusId });
        await del('mochaBeanLedgerEntry', {
          loyaltyAccount: { customerId: a.customerId },
        });
        await del('customerLoyaltyAccount', { customerId: a.customerId });
        await del('customerNote', { customerId: a.customerId });
        await del('customer', { id: a.customerId });
        await del('jobApplicationNote', { jobApplicationId: a.applicationId });
        await del('jobApplication', { jobOpeningId: a.jobId });
        await del('jobOpening', { tenantId: TENANTS.a, title: 'TBI Barista' });
        await del('franchiseInquiryNote', { franchiseInquiryId: a.inquiryId });
        await del('franchiseInquiry', { id: a.inquiryId });
        await del('locationProductPriceOverride', { locationId: a.locationId });
        await del('productModifierGroup', { productId: a.productId });
        await del('modifierOption', { modifierGroupId: a.modifierGroupId });
        await del('modifierGroup', { id: a.modifierGroupId });
        await del('locationMenu', { locationId: a.locationId });
        await del('menuProduct', { menuId: a.menuId });
        await del('menu', { id: a.menuId });
        await del('product', { id: a.productId });
        await del('category', { id: a.categoryId });
        await del('location', { id: a.locationId });
        await del('internalUserRoleAssignment', {
          internalUserId: { in: createdInA.userIds },
        });
        await del('internalRolePermission', {
          roleId: { in: createdInA.roleIds },
        });
        await del('internalRole', { id: { in: createdInA.roleIds } });
        await del('internalUser', { id: { in: createdInA.userIds } });
      }
      // B and C: everything they own, children first.
      for (const tenantId of [TENANTS.b, TENANTS.c]) {
        for (const model of [
          'internalAuditEvent',
          'approvalRequest',
          'campaignProduct',
          'campaign',
          'mediaAsset',
          'cmsPage',
          'notificationDelivery',
          'outboxEvent',
          'giftCardTransaction',
          'giftCard',
          'giftCardConfiguration',
          'loyaltyConfiguration',
          'mochaBeanLedgerEntry',
          'customerLoyaltyAccount',
          'customerNote',
          'orderStatusHistory',
          'orderLine',
          'order',
          'paymentAttempt',
          'customer',
          'promotionProduct',
          'promotionCategory',
          'promotionLocation',
          'promotion',
          'loyaltyRewardProduct',
          'loyaltyRewardCategory',
          'loyaltyReward',
          'loyaltyBonusPromotionProduct',
          'loyaltyBonusPromotionLocation',
          'loyaltyBonusPromotion',
          'jobApplicationNote',
          'jobApplication',
          'jobOpening',
          'franchiseInquiryNote',
          'franchiseInquiry',
          'operationsTask',
          'locationProductPriceOverride',
          'locationProductAvailabilityOverride',
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
          await (
            prisma as unknown as Record<
              string,
              { deleteMany(a: object): Promise<unknown> }
            >
          )[model].deleteMany({
            where: { tenantId },
          });
        }
      }
      await removeTestTenantB(prisma);
      await removeTestTenantC(prisma);
    } finally {
      for (const tag of TAGS) await apps[tag]?.close();
      process.env = { ...originalEnv };
    }
  });

  const missing = () => randomUUID();

  describe.each(PAIRS)('actor %s → target %s', (x, y) => {
    let before: Record<string, string[]>;
    beforeAll(async () => {
      before = await snapshot(TENANTS[y]);
    });

    it("lists, searches and reports never contain the other business's records", async () => {
      const foreign = ids(F[y]);
      for (const [path, ownId] of [
        ['/customers', F[x].customerId],
        [`/customers?q=${encodeURIComponent(F[y].customerEmail)}`, null],
        [
          `/loyalty/customers?query=${encodeURIComponent(F[y].customerEmail)}`,
          null,
        ],
        ['/catalog/products', F[x].productId],
        ['/catalog/menus', F[x].menuId],
        ['/careers/jobs', F[x].jobId],
        ['/careers/jobs/options', F[x].locationId],
        ['/careers/applications', F[x].applicationId],
        ['/franchising/inquiries', F[x].inquiryId],
        ['/promotions', F[x].promotionId],
        ['/promotions/options', F[x].productId],
        ['/loyalty/rewards', F[x].rewardId],
        ['/loyalty/bonus-promotions', F[x].bonusId],
        ['/loyalty/catalog-options', F[x].productId],
        ['/loyalty/bonus-promotion-options', F[x].productId],
        ['/marketing/campaigns', F[x].campaignId],
        ['/marketing/campaigns/options', F[x].productId],
        ['/media', F[x].mediaId],
        ['/locations', F[x].locationId],
        ['/internal-users', F[x].adminId],
        ['/internal-users/access-options', F[x].locationId],
        ['/approvals', null],
        ['/audit', null],
        [
          `/reports/location-performance?startDate=${resolveBusinessDate(new Date())}&endDate=${resolveBusinessDate(new Date())}`,
          F[x].locationId,
        ],
      ] as const) {
        const res = await admin(x, 'get', path).expect(200);
        const text = JSON.stringify(res.body);
        const leaked = foreign.filter((id) => text.includes(id));
        expect({ path, leaked }).toEqual({ path, leaked: [] });
        if (ownId)
          expect({ path, ownVisible: text.includes(ownId) }).toEqual({
            path,
            ownVisible: true,
          });
      }
      const search = await admin(x, 'post', '/gift-cards/search', {
        code: F[y].giftCardCode,
      }).expect(201);
      expect(JSON.stringify(search.body)).not.toContain(F[y].giftCardId);
    });

    it("every detail and location route answers the other business's id like a missing one", async () => {
      const m = missing();
      for (const [foreignPath, missingPath] of [
        [`/customers/${F[y].customerId}`, `/customers/${m}`],
        [`/customers/${F[y].customerId}/notes`, `/customers/${m}/notes`],
        [`/loyalty/customers/${F[y].customerId}`, `/loyalty/customers/${m}`],
        [`/catalog/products/${F[y].productId}`, `/catalog/products/${m}`],
        [`/catalog/menus/${F[y].menuId}`, `/catalog/menus/${m}`],
        [
          `/catalog/locations/${F[y].locationId}/menu`,
          `/catalog/locations/${m}/menu`,
        ],
        [`/careers/jobs/${F[y].jobId}`, `/careers/jobs/${m}`],
        [
          `/careers/applications/${F[y].applicationId}`,
          `/careers/applications/${m}`,
        ],
        [
          `/careers/applications/${F[y].applicationId}/notes`,
          `/careers/applications/${m}/notes`,
        ],
        [
          `/franchising/inquiries/${F[y].inquiryId}`,
          `/franchising/inquiries/${m}`,
        ],
        [
          `/franchising/inquiries/${F[y].inquiryId}/notes`,
          `/franchising/inquiries/${m}/notes`,
        ],
        [`/gift-cards/${F[y].giftCardId}`, `/gift-cards/${m}`],
        [
          `/marketing/campaigns/${F[y].campaignId}`,
          `/marketing/campaigns/${m}`,
        ],
        [`/media/${F[y].mediaId}`, `/media/${m}`],
        [`/internal-users/${F[y].adminId}`, `/internal-users/${m}`],
        [`/locations/${F[y].locationId}`, `/locations/${m}`],
        [`/orders?locationId=${F[y].locationId}`, `/orders?locationId=${m}`],
        [
          `/orders/${F[y].orderId}?locationId=${F[y].locationId}`,
          `/orders/${m}?locationId=${m}`,
        ],
        [
          `/orders/${F[y].orderId}?locationId=${F[x].locationId}`,
          `/orders/${m}?locationId=${F[x].locationId}`,
        ],
        [
          `/operations/tasks?locationId=${F[y].locationId}`,
          `/operations/tasks?locationId=${m}`,
        ],
        [
          `/operations/opening-checklist?locationId=${F[y].locationId}`,
          `/operations/opening-checklist?locationId=${m}`,
        ],
      ]) {
        const foreign = await admin(x, 'get', foreignPath);
        const absent = await admin(x, 'get', missingPath);
        expect({ foreignPath, status: foreign.status }).toEqual({
          foreignPath,
          status: absent.status,
        });
        expect([403, 404]).toContain(foreign.status);
        expect(foreign.body).toEqual(absent.body);
      }
    });

    it("every write against the other business's records fails like a write against a missing record, and changes nothing", async () => {
      const m = missing();
      const writes: Array<
        [
          method: 'post' | 'patch' | 'put',
          path: (id: string, loc: string) => string,
          body: (loc: string) => object,
          foreignId: string,
        ]
      > = [
        [
          'post',
          (id) => `/customers/${id}/notes`,
          () => ({ body: 'TBI cross note' }),
          F[y].customerId,
        ],
        [
          'post',
          (id) => `/loyalty/customers/${id}/adjustments`,
          () => ({ deltaBeans: 50, reason: 'TBI', operationKey: randomUUID() }),
          F[y].customerId,
        ],
        [
          'patch',
          (id) => `/catalog/products/${id}`,
          () => ({ name: 'TBI hijack' }),
          F[y].productId,
        ],
        [
          'patch',
          (id) => `/careers/jobs/${id}`,
          () => ({ title: 'TBI hijack' }),
          F[y].jobId,
        ],
        ['post', (id) => `/careers/jobs/${id}/archive`, () => ({}), F[y].jobId],
        [
          'post',
          (id) => `/careers/applications/${id}/notes`,
          () => ({ body: 'TBI cross note' }),
          F[y].applicationId,
        ],
        [
          'post',
          (id) => `/careers/applications/${id}/status`,
          () => ({ status: 'REVIEWED' }),
          F[y].applicationId,
        ],
        [
          'post',
          (id) => `/franchising/inquiries/${id}/notes`,
          () => ({ body: 'TBI cross note' }),
          F[y].inquiryId,
        ],
        [
          'post',
          (id) => `/franchising/inquiries/${id}/status`,
          () => ({ status: 'CONTACTED' }),
          F[y].inquiryId,
        ],
        [
          'patch',
          (id) => `/promotions/${id}`,
          () => ({ name: 'TBI hijack' }),
          F[y].promotionId,
        ],
        [
          'patch',
          (id) => `/loyalty/rewards/${id}`,
          () => ({ beanCost: 1 }),
          F[y].rewardId,
        ],
        [
          'patch',
          (id) => `/loyalty/bonus-promotions/${id}`,
          () => ({ isActive: false }),
          F[y].bonusId,
        ],
        [
          'post',
          (id) => `/gift-cards/${id}/deactivate`,
          () => ({}),
          F[y].giftCardId,
        ],
        [
          'post',
          (id) => `/gift-cards/${id}/corrections`,
          () => ({
            deltaMinorUnits: -100,
            reason: 'TBI',
            operationKey: randomUUID(),
          }),
          F[y].giftCardId,
        ],
        [
          'patch',
          (id) => `/marketing/campaigns/${id}`,
          () => ({ name: 'TBI hijack' }),
          F[y].campaignId,
        ],
        [
          'post',
          (id) => `/marketing/campaigns/${id}/request-approval`,
          () => ({}),
          F[y].campaignId,
        ],
        [
          'patch',
          (id) => `/media/${id}`,
          () => ({ title: 'TBI hijack' }),
          F[y].mediaId,
        ],
        ['post', (id) => `/media/${id}/deactivate`, () => ({}), F[y].mediaId],
        [
          'patch',
          (id) => `/internal-users/${id}/status`,
          () => ({ status: 'SUSPENDED', reason: 'TBI' }),
          F[y].adminId,
        ],
        [
          'patch',
          (id) => `/locations/${id}`,
          () => ({ name: 'TBI hijack' }),
          F[y].locationId,
        ],
        [
          'patch',
          (id) => `/locations/${id}/digital-ordering`,
          () => ({ isDigitalOrderingEnabled: false }),
          F[y].locationId,
        ],
        [
          'post',
          () => `/operations/tasks`,
          (loc) => ({ locationId: loc, title: 'TBI cross task' }),
          F[y].locationId,
        ],
        [
          'post',
          () => `/operations/tasks/${F[y].taskId}/complete`,
          (loc) => ({ locationId: loc }),
          F[y].locationId,
        ],
        [
          'post',
          () => `/orders/${F[y].orderId}/advance`,
          (loc) => ({ locationId: loc }),
          F[y].locationId,
        ],
        [
          'put',
          (id) =>
            `/catalog/locations/${id}/menus/${F[y].menuId}/products/${F[y].productId}/price-override`,
          () => ({ price: 1 }),
          F[y].locationId,
        ],
      ];
      for (const [method, path, body, foreignId] of writes) {
        const foreign = await admin(
          x,
          method,
          path(foreignId, foreignId),
          body(foreignId),
        );
        const absent = await admin(x, method, path(m, m), body(m));
        const label = `${method.toUpperCase()} ${path(':id', ':loc')}`;
        expect({ label, status: foreign.status }).toEqual({
          label,
          status: absent.status,
        });
        expect(foreign.status).toBeGreaterThanOrEqual(400);
        expect(foreign.body).toEqual(absent.body);
      }
      expect(await snapshot(TENANTS[y])).toEqual(before);
    });

    it("cannot attach the other business's records to its own", async () => {
      for (const [path, body] of [
        [
          '/promotions',
          {
            name: 'TBI x',
            kind: 'AUTOMATIC',
            discountType: 'PERCENTAGE_OFF',
            discountValue: 10,
            applicability: 'SELECTED_PRODUCTS',
            eligibleProductIds: [F[y].productId],
            appliesToAllLocations: true,
          },
        ],
        [
          '/promotions',
          {
            name: 'TBI x',
            kind: 'AUTOMATIC',
            discountType: 'PERCENTAGE_OFF',
            discountValue: 10,
            appliesToAllLocations: false,
            eligibleLocationIds: [F[y].locationId],
          },
        ],
        [
          '/loyalty/rewards',
          {
            name: 'TBI x',
            type: 'FREE_ITEM',
            beanCost: 5,
            eligibleProductIds: [F[y].productId],
          },
        ],
        [
          '/loyalty/bonus-promotions',
          {
            name: 'TBI x',
            type: 'EXTRA_BEANS',
            bonusValue: 5,
            eligibleProductIds: [F[y].productId],
            appliesToAllLocations: true,
          },
        ],
        ['/marketing/campaigns', { name: 'TBI x', mediaAssetId: F[y].mediaId }],
        [
          '/marketing/campaigns',
          { name: 'TBI x', promotionId: F[y].promotionId },
        ],
        [
          '/marketing/campaigns',
          { name: 'TBI x', featuredProductIds: [F[y].productId] },
        ],
        [
          '/careers/jobs',
          {
            title: 'TBI x',
            employmentType: 'FULL_TIME',
            summary: 's',
            description: 'd',
            responsibilities: 'r',
            qualifications: 'q',
            locationId: F[y].locationId,
          },
        ],
      ] as const) {
        const res = await admin(x, 'post', path, body);
        expect({ path, status: res.status }).toEqual({ path, status: 400 });
      }
      // Nothing of X points at Y.
      const yIds = ids(F[y]);
      for (const [model, field] of [
        ['promotionProduct', 'productId'],
        ['promotionLocation', 'locationId'],
        ['loyaltyRewardProduct', 'productId'],
        ['loyaltyBonusPromotionProduct', 'productId'],
        ['campaignProduct', 'productId'],
        ['campaign', 'mediaAssetId'],
        ['campaign', 'promotionId'],
        ['jobOpening', 'locationId'],
      ] as const) {
        const count = await (
          prisma as unknown as Record<
            string,
            { count(a: object): Promise<number> }
          >
        )[model].count({
          where: { tenantId: TENANTS[x], [field]: { in: yIds } },
        });
        expect({ model, field, count }).toEqual({ model, field, count: 0 });
      }
      expect(await snapshot(TENANTS[y])).toEqual(before);
    });

    it("the actor's storefront neither shows nor accepts the other business's records", async () => {
      const foreign = ids(F[y]);
      for (const path of [
        '/catalog/categories',
        '/catalog/products',
        '/catalog/menus',
        '/catalog/modifier-groups',
        '/locations',
        '/careers/jobs',
      ]) {
        const text = JSON.stringify(
          (await store(x, 'get', path).expect(200)).body,
        );
        expect({
          path,
          leaked: foreign.filter((id) => text.includes(id)),
        }).toEqual({ path, leaked: [] });
      }
      const m = missing();
      for (const [a, b] of [
        [`/locations/${F[y].locationId}/menu`, `/locations/${m}/menu`],
        [`/careers/jobs/${F[y].jobId}`, `/careers/jobs/${m}`],
      ]) {
        const fr = await store(x, 'get', a);
        const mr = await store(x, 'get', b);
        expect([fr.status, fr.body]).toEqual([mr.status, mr.body]);
      }
      const line = (f: Fixtures) => [
        { productId: f.productId, quantity: 1, selections: [] },
      ];
      const foreignQuote = await store(x, 'post', '/orders/checkout-quote', {
        locationId: F[y].locationId,
        lines: line(F[y]),
      });
      const missingQuote = await store(x, 'post', '/orders/checkout-quote', {
        locationId: m,
        lines: line(F[y]),
      });
      expect([foreignQuote.status, foreignQuote.body]).toEqual([
        404,
        missingQuote.body,
      ]);
      // The shared coupon code resolves to the ACTOR's own coupon only.
      const quote = await store(x, 'post', '/orders/checkout-quote', {
        locationId: F[x].locationId,
        lines: line(F[x]),
        couponCode,
        giftCardCode: F[y].giftCardCode,
      }).expect(200);
      const body = quote.body as {
        couponStatus: string;
        regularDiscount: { name: string } | null;
        giftCardStatus: string;
      };
      expect(body.couponStatus).toBe('applied');
      expect(body.regularDiscount?.name).toBe(`TBI-${x} coupon`);
      expect(body.giftCardStatus).toBe('not_found');
      const balance = await store(x, 'post', '/gift-cards/balance', {
        code: F[y].giftCardCode,
      }).expect(200);
      expect(balance.body).toEqual({ found: false });
      const apply = await store(
        x,
        'post',
        `/careers/jobs/${F[y].jobId}/applications`,
        {
          firstName: 'TBI',
          lastName: 'x',
          email: `tbi-x-${suffix}@example.test`,
          phone: '5550000000',
          location: 'Detroit, MI',
          workAuthorized: true,
          availability: 'any',
          message: 'hi',
        },
      );
      expect(apply.status).toBe(404);
      expect(await snapshot(TENANTS[y])).toEqual(before);
    });
  });

  it('the same writes succeed on the actor’s own records (the request bodies above are valid)', async () => {
    for (const tag of TAGS) {
      const f = F[tag];
      for (const [method, path, body] of [
        ['post', `/customers/${f.customerId}/notes`, { body: 'TBI own note' }],
        [
          'post',
          `/loyalty/customers/${f.customerId}/adjustments`,
          { deltaBeans: 5, reason: 'TBI', operationKey: randomUUID() },
        ],
        ['patch', `/catalog/products/${f.productId}`, { name: 'TBI Latte' }],
        ['patch', `/careers/jobs/${f.jobId}`, { title: 'TBI Barista' }],
        [
          'post',
          `/careers/applications/${f.applicationId}/notes`,
          { body: 'TBI own note' },
        ],
        [
          'post',
          `/franchising/inquiries/${f.inquiryId}/notes`,
          { body: 'TBI own note' },
        ],
        [
          'patch',
          `/promotions/${f.promotionId}`,
          { name: `TBI-${tag} coupon` },
        ],
        ['patch', `/loyalty/rewards/${f.rewardId}`, { beanCost: 10 }],
        ['patch', `/loyalty/bonus-promotions/${f.bonusId}`, { bonusValue: 5 }],
        [
          'post',
          `/gift-cards/${f.giftCardId}/corrections`,
          { deltaMinorUnits: -100, reason: 'TBI', operationKey: randomUUID() },
        ],
        [
          'patch',
          `/marketing/campaigns/${f.campaignId}`,
          { name: 'TBI campaign' },
        ],
        ['patch', `/media/${f.mediaId}`, { title: 'TBI image' }],
        ['patch', `/locations/${f.locationId}`, { name: 'TBI Main Street' }],
        [
          'post',
          '/operations/tasks',
          { locationId: f.locationId, title: 'TBI own task' },
        ],
        [
          'put',
          `/catalog/locations/${f.locationId}/menus/${f.menuId}/products/${f.productId}/price-override`,
          { price: 450 },
        ],
      ] as const) {
        const res = await admin(tag, method, path, body);
        expect({ tag, path, status: res.status < 300 }).toEqual({
          tag,
          path,
          status: true,
        });
      }
    }
  });

  it('a person in two businesses (neither Mocha House) sees only the selected business, within that business’s permissions', async () => {
    const asB = await admin(
      'b',
      'get',
      '/catalog/products',
      undefined,
      'multi',
    ).expect(200);
    const asC = await admin(
      'c',
      'get',
      '/catalog/products',
      undefined,
      'multi',
    ).expect(200);
    expect(JSON.stringify(asB.body)).toContain(F.b.productId);
    expect(JSON.stringify(asB.body)).not.toContain(F.c.productId);
    expect(JSON.stringify(asC.body)).toContain(F.c.productId);
    expect(JSON.stringify(asC.body)).not.toContain(F.b.productId);
    // Customers are visible in B (all permissions) but not in C (catalog only).
    await admin('b', 'get', '/customers', undefined, 'multi').expect(200);
    await admin('c', 'get', '/customers', undefined, 'multi').expect(403);
    // Not a member of Mocha House at all.
    await admin('a', 'get', '/catalog/products', undefined, 'multi').expect(
      403,
    );
    // From B, C's product is as missing as a random id.
    const m = missing();
    const foreign = await admin(
      'b',
      'get',
      `/catalog/products/${F.c.productId}`,
      undefined,
      'multi',
    );
    const absent = await admin(
      'b',
      'get',
      `/catalog/products/${m}`,
      undefined,
      'multi',
    );
    expect([foreign.status, foreign.body]).toEqual([404, absent.body]);
  });
});
