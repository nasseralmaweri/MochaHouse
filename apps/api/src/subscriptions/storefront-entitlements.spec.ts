import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  FEATURE_NOT_AVAILABLE,
  STOREFRONT_FEATURE_KEYS,
  type CheckoutRequest,
  type GiftCardPurchaseIntentResponse,
  type PurchaseGiftCardResponse,
  type StorefrontFeaturesResponse,
} from '@mocha-house/contracts';
import type {
  ChargeResult,
  FakePaymentProvider,
} from '@mocha-house/integrations';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  tenantContextFor,
  type ScratchDatabase,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisModule } from '../redis/redis.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { LocationsModule } from '../locations/locations.module';
import { CatalogModule } from '../catalog/catalog.module';
import { CareersModule } from '../careers/careers.module';
import { FranchisingModule } from '../franchising/franchising.module';
import { CmsModule } from '../cms/cms.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { CustomersModule } from '../customers/customers.module';
import { LoyaltyModule } from '../loyalty/loyalty.module';
import { PromotionsModule } from '../promotions/promotions.module';
import { GiftCardsModule } from '../gift-cards/gift-cards.module';
import { PaymentModule } from '../payment/payment.module';
import { OrdersController } from '../orders/api/orders.controller';
import { CheckoutService } from '../orders/application/checkout.service';
import { PAYMENT_PROVIDER } from '../orders/infrastructure/payment-provider.token';
import { CustomerLoyaltyController } from '../loyalty/api/customer-loyalty.controller';
import type {
  CustomerAuthenticatedRequest,
  CustomerIdentity,
} from '../customer-auth/infrastructure/customer-identity';
import { CareersPublicThrottleGuard } from '../careers/infrastructure/careers-public-throttle.guard';
import { FranchisingPublicThrottleGuard } from '../franchising/infrastructure/franchising-public-throttle.guard';
import { GiftCardPublicThrottleGuard } from '../gift-cards/infrastructure/gift-card-public-throttle.guard';
import {
  canonicalizeGiftCardCode,
  generateGiftCardCode,
  hashGiftCardCode,
} from '../gift-cards/infrastructure/gift-card-code';
import { SubscriptionsModule } from './subscriptions.module';

// SC2b — customer-facing entitlement enforcement, end to end in a SCRATCH
// database (it creates businesses and changes their subscriptions, which the
// shared test database must never hold). Two storefronts run side by side:
//   FULL — a business on the published Founding plan (every module);
//   CORE — a business with no subscription (core only, fail closed).
// Covered: the public features endpoint and its isolation, careers /
// franchising / website content, gift-card sales vs existing-card balance and
// redemption, checkout (coupons, automatic promotions, rewards, earning)
// refused BEFORE payment, a module removed WHILE a checkout is being paid,
// idempotent replay after a downgrade, gift-card purchase recovery, and
// customer balances kept intact across a downgrade and re-entitlement.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const FOUNDING_VERSION = '01a0db02-f800-7000-8000-00000000f002';

describe('SC2b storefront entitlements (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let full: INestApplication<App>;
  let core: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  const FULL = randomUUID();
  const CORE = randomUUID();

  type Shop = { locationId: string; productId: string; jobId: string };
  let fullShop: Shop;
  let coreShop: Shop;

  async function buildStorefront(tenantId: string) {
    process.env.SINGLE_TENANT_ID = tenantId;
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        RedisModule,
        RateLimitModule,
        TenancyModule,
        SubscriptionsModule,
        LocationsModule,
        CatalogModule,
        CareersModule,
        FranchisingModule,
        CmsModule,
        CustomerAuthModule,
        InternalAuthModule,
        CustomersModule,
        LoyaltyModule,
        PromotionsModule,
        GiftCardsModule,
        PaymentModule,
      ],
      controllers: [OrdersController],
      providers: [CheckoutService],
    })
      // Every supertest request shares one loopback IP.
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

  const subscribe = (tenantId: string) =>
    prisma.tenantSubscription.create({
      data: { subscriberTenantId: tenantId, planVersionId: FOUNDING_VERSION },
    });
  // A test-made subscription has no history rows, so it can simply be removed:
  // the business is then core only.
  const unsubscribe = (tenantId: string) =>
    prisma.tenantSubscription.deleteMany({
      where: { subscriberTenantId: tenantId },
    });

  async function shopFor(tenantId: string, label: string): Promise<Shop> {
    const location = await prisma.location.create({
      data: {
        tenantId,
        name: `SC2b ${label} ${run}`,
        slug: `sc2b-${label}-${run}`,
        isActive: true,
        isDigitalOrderingEnabled: true,
      },
    });
    const category = await prisma.category.create({
      data: { tenantId, name: `SC2b Cat ${run}`, slug: `sc2b-cat-${run}` },
    });
    const product = await prisma.product.create({
      data: {
        tenantId,
        name: `SC2b Latte ${run}`,
        slug: `sc2b-latte-${run}`,
        categoryId: category.id,
        basePrice: 1000,
        currency: 'USD',
      },
    });
    const menu = await prisma.menu.create({
      data: { tenantId, name: `SC2b Menu ${run}`, slug: `sc2b-menu-${run}` },
    });
    await prisma.menuProduct.create({
      data: {
        tenantId,
        menuId: menu.id,
        productId: product.id,
        isActive: true,
      },
    });
    await prisma.locationMenu.create({
      data: {
        tenantId,
        locationId: location.id,
        menuId: menu.id,
        isActive: true,
      },
    });
    const job = await prisma.jobOpening.create({
      data: {
        tenantId,
        title: `SC2b Barista ${run}`,
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
    await prisma.cmsPage.create({
      data: {
        tenantId,
        key: 'franchising',
        title: 'Franchising',
        status: 'PUBLISHED',
        draftContent: { label },
        publishedContent: { label },
        publishedAt: new Date(),
      },
    });
    await prisma.loyaltyConfiguration.create({
      data: { tenantId, key: 'company', earningRatePerDollar: 1 },
    });
    return { locationId: location.id, productId: product.id, jobId: job.id };
  }

  async function coupon(tenantId: string, code: string) {
    await prisma.promotion.create({
      data: {
        tenantId,
        name: `SC2b coupon ${code}`,
        kind: 'COUPON',
        code,
        discountType: 'FIXED_AMOUNT',
        discountValue: 200,
        applicability: 'ENTIRE_ORDER',
        isActive: true,
        appliesToAllLocations: true,
      },
    });
  }

  async function automaticPromotion(tenantId: string) {
    await prisma.promotion.create({
      data: {
        tenantId,
        name: `SC2b automatic ${randomUUID()}`,
        kind: 'AUTOMATIC',
        discountType: 'FIXED_AMOUNT',
        discountValue: 100,
        applicability: 'ENTIRE_ORDER',
        isActive: true,
        appliesToAllLocations: true,
      },
    });
  }

  async function reward(tenantId: string, beanCost: number, off: number) {
    return (
      await prisma.loyaltyReward.create({
        data: {
          tenantId,
          name: `SC2b $${off / 100} off ${randomUUID()}`,
          type: 'FIXED_AMOUNT',
          beanCost,
          fixedAmountMinorUnits: off,
        },
      })
    ).id;
  }

  function identity(key: string): CustomerIdentity {
    return {
      provider: 'test',
      subject: `sc2b-${key}-${run}`,
      email: `sc2b-${key}-${run}@example.com`,
      name: null,
      emailVerified: null,
    };
  }

  // A signed-in customer of `tenantId` holding `beans`.
  async function customerWithBeans(
    tenantId: string,
    key: string,
    beans: number,
  ) {
    const id = identity(key);
    const customer = await prisma.customer.create({
      data: {
        tenantId,
        externalProvider: id.provider,
        externalSubject: id.subject,
        email: id.email,
      },
    });
    await prisma.customerLoyaltyAccount.create({
      data: { tenantId, customerId: customer.id, balance: beans },
    });
    return { id, customerId: customer.id };
  }

  const balanceOf = async (customerId: string) =>
    (
      await prisma.customerLoyaltyAccount.findUniqueOrThrow({
        where: { customerId },
      })
    ).balance;
  const ledgerCount = (customerId: string) =>
    prisma.mochaBeanLedgerEntry.count({
      where: { loyaltyAccount: { customerId } },
    });

  async function giftCard(tenantId: string, balance: number) {
    const code = generateGiftCardCode();
    const canonical = canonicalizeGiftCardCode(code)!;
    const card = await prisma.giftCard.create({
      data: {
        tenantId,
        codeHash: hashGiftCardCode(canonical),
        last4: canonical.slice(-4),
        status: 'ACTIVE',
        originalValueMinorUnits: balance,
        balanceMinorUnits: balance,
        currency: 'USD',
        transactions: {
          create: {
            type: 'ISSUANCE',
            amountMinorUnits: balance,
            balanceAfterMinorUnits: balance,
          },
        },
      },
    });
    return { id: card.id, code };
  }

  function order(
    shop: Shop,
    over: Partial<CheckoutRequest> = {},
  ): CheckoutRequest {
    return {
      idempotencyKey: `sc2b_${randomUUID()}`,
      locationId: shop.locationId,
      guest: { name: 'SC2b Guest', phone: '5551234567' },
      lines: [{ productId: shop.productId, quantity: 1, selections: [] }],
      ...over,
    };
  }

  const checkoutOf = (app: INestApplication<App>) => app.get(CheckoutService);
  const attemptFor = (idempotencyKey: string) =>
    prisma.paymentAttempt.findUnique({ where: { idempotencyKey } });

  async function expectFeatureRefusal(
    promise: Promise<unknown>,
    feature: string,
  ) {
    await expect(promise).rejects.toMatchObject({
      status: 403,
      response: { code: FEATURE_NOT_AVAILABLE, feature },
    });
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc2b_storefront',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    process.env.DATABASE_URL = scratch.url;
    process.env.RATE_LIMIT_ENABLED = '0';

    // The businesses must exist before their storefronts boot.
    full = await buildStorefront(await ensureTenants());
    core = await buildStorefront(CORE);
    prisma = full.get(PrismaService);

    fullShop = await shopFor(FULL, 'full');
    coreShop = await shopFor(CORE, 'core');
  });

  // Creates both businesses through a throwaway storefront-free Prisma (the
  // first storefront needs them to exist), subscribing FULL to Founding.
  async function ensureTenants(): Promise<string> {
    const moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
    }).compile();
    const db = moduleRef.get(PrismaService);
    for (const [id, label] of [
      [FULL, 'full'],
      [CORE, 'core'],
    ] as const) {
      await db.tenant.create({
        data: {
          id,
          slug: `sc2b-${label}-${run}`,
          name: `SC2b ${label}`,
          status: 'ACTIVE',
        },
      });
    }
    await db.tenantSubscription.create({
      data: { subscriberTenantId: FULL, planVersionId: FOUNDING_VERSION },
    });
    await moduleRef.close();
    return FULL;
  }

  afterAll(async () => {
    try {
      await full?.close();
      await core?.close();
    } finally {
      process.env = { ...originalEnv };
      await scratch?.drop();
    }
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    // Every test starts with FULL on Founding and CORE on core only.
    if (
      !(await prisma.tenantSubscription.findUnique({
        where: { subscriberTenantId: FULL },
      }))
    ) {
      await subscribe(FULL);
    }
    await unsubscribe(CORE);
  });

  // --- Features endpoint and isolation -------------------------------------

  it("reports only availability, for the storefront's own business, and ignores a client-supplied business id", async () => {
    const fullFeatures = (
      await request(full.getHttpServer())
        .get('/api/v1/storefront/features')
        .expect(200)
    ).body as StorefrontFeaturesResponse;
    expect(fullFeatures).toEqual({
      features: Object.fromEntries(
        STOREFRONT_FEATURE_KEYS.map((k) => [k, true]),
      ),
    });

    const spoofed = (
      await request(core.getHttpServer())
        .get('/api/v1/storefront/features')
        .set('X-Tenant-Id', FULL)
        .query({ tenantId: FULL })
        .expect(200)
    ).body as StorefrontFeaturesResponse;
    expect(spoofed).toEqual({
      features: Object.fromEntries(
        STOREFRONT_FEATURE_KEYS.map((k) => [k, false]),
      ),
    });
    // Never the plan name, modules outside the storefront, or anything else.
    expect(Object.keys(spoofed)).toEqual(['features']);
    expect(Object.keys(spoofed.features).sort()).toEqual(
      [...STOREFRONT_FEATURE_KEYS].sort(),
    );
  });

  it("one business's plan change never affects another business", async () => {
    await unsubscribe(FULL);
    await subscribe(CORE);
    const featuresOf = async (app: INestApplication<App>) =>
      (
        (await request(app.getHttpServer()).get('/api/v1/storefront/features'))
          .body as StorefrontFeaturesResponse
      ).features;
    expect((await featuresOf(full)).careers).toBe(false);
    expect((await featuresOf(core)).careers).toBe(true);
    await request(core.getHttpServer())
      .get(`/api/v1/careers/jobs/${coreShop.jobId}`)
      .expect(200);
    await request(full.getHttpServer())
      .get(`/api/v1/careers/jobs/${fullShop.jobId}`)
      .expect(404);
  });

  // --- Careers, franchising, website content -------------------------------

  it('careers: openings are 404 and applications are refused (nothing stored or queued) without the module', async () => {
    await request(core.getHttpServer()).get('/api/v1/careers/jobs').expect(404);
    await request(core.getHttpServer())
      .get(`/api/v1/careers/jobs/${coreShop.jobId}`)
      .expect(404);
    const refused = await request(core.getHttpServer())
      .post(`/api/v1/careers/jobs/${coreShop.jobId}/applications`)
      .send({
        firstName: 'Sam',
        lastName: 'Test',
        email: `apply-${run}@example.com`,
        phone: '5551234567',
        location: 'Dearborn, MI',
        workAuthorized: true,
        availability: 'Weekends',
        message: 'Hello',
      })
      .expect(403);
    expect(refused.body).toMatchObject({
      code: FEATURE_NOT_AVAILABLE,
      feature: 'careers',
    });
    expect(
      await prisma.jobApplication.count({ where: { tenantId: CORE } }),
    ).toBe(0);
    expect(
      await prisma.outboxEvent.count({
        where: { tenantId: CORE, aggregateType: 'JobApplication' },
      }),
    ).toBe(0);

    const listed = await request(full.getHttpServer())
      .get('/api/v1/careers/jobs')
      .expect(200);
    expect(JSON.stringify(listed.body)).toContain(fullShop.jobId);
  });

  it('franchising: a new inquiry is refused before anything is stored or queued without the module', async () => {
    const body = {
      firstName: 'Pat',
      lastName: 'Test',
      email: `franchise-${run}@example.com`,
      phone: '5551234567',
      city: 'Dearborn',
      state: 'MI',
      country: 'USA',
      preferredMarket: 'Detroit',
      consentAcknowledged: true,
    };
    const refused = await request(core.getHttpServer())
      .post('/api/v1/franchising/inquiries')
      .send(body)
      .expect(403);
    expect(refused.body).toMatchObject({
      code: FEATURE_NOT_AVAILABLE,
      feature: 'franchising',
    });
    expect(
      await prisma.franchiseInquiry.count({ where: { tenantId: CORE } }),
    ).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { tenantId: CORE } })).toBe(
      0,
    );

    await request(full.getHttpServer())
      .post('/api/v1/franchising/inquiries')
      .send(body)
      .expect(201);
  });

  it('website content: a published page is 404 without the module, kept, and back on re-entitlement', async () => {
    await request(core.getHttpServer())
      .get('/api/v1/content/franchising')
      .expect(404);
    expect(
      await prisma.cmsPage.count({
        where: { tenantId: CORE, key: 'franchising' },
      }),
    ).toBe(1);
    await subscribe(CORE);
    const page = await request(core.getHttpServer())
      .get('/api/v1/content/franchising')
      .expect(200);
    expect(JSON.stringify(page.body)).toContain('core');
  });

  // --- Gift cards (B1) ------------------------------------------------------

  it('gift cards: no new sale without the module, but an existing card keeps its balance check and is still accepted at checkout', async () => {
    const refusedOptions = await request(core.getHttpServer())
      .get('/api/v1/gift-cards/purchase-options')
      .expect(403);
    expect(refusedOptions.body).toMatchObject({ feature: 'giftcards' });

    const idempotencyKey = randomUUID();
    await request(core.getHttpServer())
      .post('/api/v1/gift-cards/purchase-intents')
      .send({
        idempotencyKey,
        amountMinorUnits: 2500,
        purchaserEmail: `buyer-${run}@example.com`,
      })
      .expect(403);
    expect(await attemptFor(idempotencyKey)).toBeNull();

    const card = await giftCard(CORE, 600);
    const balance = await request(core.getHttpServer())
      .post('/api/v1/gift-cards/balance')
      .send({ code: card.code })
      .expect(200);
    expect(balance.body).toMatchObject({ found: true, balanceMinorUnits: 600 });

    const placed = await checkoutOf(core).checkout(
      order(coreShop, { giftCardCode: card.code }),
      undefined,
      tenantContextFor(CORE),
    );
    expect(placed.orderId).toBeDefined();
    const after = await prisma.giftCard.findUniqueOrThrow({
      where: { id: card.id },
    });
    expect(after.balanceMinorUnits).toBe(0);
  });

  it('gift-card purchase: removed after the intent but before the charge is refused with nothing charged; a purchase charged before removal replays normally', async () => {
    const http = () => request(full.getHttpServer());
    const startIntent = async () => {
      const idempotencyKey = randomUUID();
      const intent = (
        await http()
          .post('/api/v1/gift-cards/purchase-intents')
          .send({
            idempotencyKey,
            amountMinorUnits: 2500,
            purchaserEmail: `buyer-${run}@example.com`,
          })
          .expect(201)
      ).body as GiftCardPurchaseIntentResponse;
      return { idempotencyKey, credential: intent.recoveryCredential };
    };

    // Removed between the two steps: refused before the charge claim.
    const pending = await startIntent();
    await unsubscribe(FULL);
    const charge = jest.spyOn(
      full.get<FakePaymentProvider>(PAYMENT_PROVIDER),
      'charge',
    );
    await http()
      .post('/api/v1/gift-cards/purchase')
      .send({
        idempotencyKey: pending.idempotencyKey,
        recoveryCredential: pending.credential,
      })
      .expect(403);
    expect(charge).not.toHaveBeenCalled();
    const held = await attemptFor(pending.idempotencyKey);
    expect(held).toMatchObject({ status: 'PENDING', paymentState: 'NOT_SENT' });

    // Re-entitled: the same intent completes, charged exactly once.
    await subscribe(FULL);
    const done = (
      await http()
        .post('/api/v1/gift-cards/purchase')
        .send({
          idempotencyKey: pending.idempotencyKey,
          recoveryCredential: pending.credential,
        })
        .expect(201)
    ).body as PurchaseGiftCardResponse;
    expect(done.status).toBe('ISSUED');
    expect(charge).toHaveBeenCalledTimes(1);

    // Removed AFTER the charge: the paid purchase replays (code recovery
    // still works) and is never charged again.
    await unsubscribe(FULL);
    const replay = (
      await http()
        .post('/api/v1/gift-cards/purchase')
        .send({
          idempotencyKey: pending.idempotencyKey,
          recoveryCredential: pending.credential,
        })
        .expect(201)
    ).body as PurchaseGiftCardResponse;
    expect(replay.purchaseId).toBe(done.purchaseId);
    expect(replay.code).toBe(done.code);
    expect(charge).toHaveBeenCalledTimes(1);
  });

  // --- Checkout --------------------------------------------------------------

  it('checkout without the modules: a coupon or reward is refused before any payment attempt; no automatic promotion or earning; the balance is untouched', async () => {
    const code = `SC2B${run}`.toUpperCase();
    await coupon(CORE, code);
    await automaticPromotion(CORE);
    const rewardId = await reward(CORE, 10, 300);
    const customer = await customerWithBeans(CORE, 'core-buyer', 50);
    const tenant = tenantContextFor(CORE);

    const withCoupon = order(coreShop, { couponCode: code });
    await expectFeatureRefusal(
      checkoutOf(core).checkout(withCoupon, customer.id, tenant),
      'promotions',
    );
    expect(await attemptFor(withCoupon.idempotencyKey)).toBeNull();

    const withReward = order(coreShop, { loyaltyRewardId: rewardId });
    await expectFeatureRefusal(
      checkoutOf(core).checkout(withReward, customer.id, tenant),
      'loyalty',
    );
    expect(await attemptFor(withReward.idempotencyKey)).toBeNull();

    // Core ordering and payment keep working, at full price, earning nothing.
    const plain = order(coreShop);
    const placed = await checkoutOf(core).checkout(plain, customer.id, tenant);
    const placedOrder = await prisma.order.findUniqueOrThrow({
      where: { id: placed.orderId },
    });
    expect(placedOrder).toMatchObject({
      subtotal: 1000,
      promotionDiscountMinorUnits: 0,
      rewardDiscountMinorUnits: 0,
    });
    expect((await attemptFor(plain.idempotencyKey))?.amount).toBe(1000);
    expect(await balanceOf(customer.customerId)).toBe(50);
    expect(await ledgerCount(customer.customerId)).toBe(0);

    // The quote reflects it.
    const quote = await checkoutOf(core).quoteCheckout(
      {
        locationId: coreShop.locationId,
        lines: plain.lines,
        couponCode: code,
        loyaltyRewardId: rewardId,
      },
      customer.id,
      tenant,
    );
    expect(quote).toMatchObject({
      promotionsAvailable: false,
      loyaltyAvailable: false,
      couponStatus: 'not_available',
      regularDiscount: null,
      rewards: [],
      rewardDiscountMinorUnits: 0,
      balance: 50,
      total: 1000,
    });

    // The customer's own summary keeps the balance, offers no reward.
    const summary = await core
      .get(CustomerLoyaltyController)
      .getSummary(
        { customerIdentity: customer.id } as CustomerAuthenticatedRequest,
        tenant,
      );
    expect(summary).toEqual({ balance: 50, rewards: [], available: false });
  });

  it('a module removed WHILE the checkout is being paid: the paid order completes exactly as authorised, with no reconciliation, and a retry replays it', async () => {
    const code = `MID${run}`.toUpperCase();
    await coupon(FULL, code);
    const rewardId = await reward(FULL, 20, 300);
    const customer = await customerWithBeans(FULL, 'mid-buyer', 100);
    const tenant = tenantContextFor(FULL);
    const provider = full.get<FakePaymentProvider>(PAYMENT_PROVIDER);
    // The plan loses every optional module after the pre-payment checks,
    // while the provider is charging; the charge then succeeds.
    const charge = jest
      .spyOn(provider, 'charge')
      .mockImplementation(async (): Promise<ChargeResult> => {
        await unsubscribe(FULL);
        return { outcome: 'succeeded', providerReference: `fake_${run}` };
      });

    const submission = order(fullShop, {
      couponCode: code,
      loyaltyRewardId: rewardId,
    });
    const placed = await checkoutOf(full).checkout(
      submission,
      customer.id,
      tenant,
    );
    expect(charge).toHaveBeenCalledTimes(1);

    const attempt = await attemptFor(submission.idempotencyKey);
    // $10.00 - $2.00 coupon - $3.00 reward = $5.00 charged.
    expect(attempt).toMatchObject({
      status: 'SUCCEEDED',
      amount: 500,
      reconciliationRequired: false,
    });
    const placedOrder = await prisma.order.findUniqueOrThrow({
      where: { id: placed.orderId },
      include: { promotionRedemption: true, loyaltyRewardRedemption: true },
    });
    expect(placedOrder).toMatchObject({
      promotionDiscountMinorUnits: 200,
      rewardDiscountMinorUnits: 300,
    });
    expect(placedOrder.promotionRedemption).not.toBeNull();
    expect(placedOrder.loyaltyRewardRedemption).not.toBeNull();
    // 100 - 20 redeemed + 5 earned on the $5.00 qualifying spend.
    expect(await balanceOf(customer.customerId)).toBe(85);

    // Still downgraded: the same key replays the stored order, re-runs
    // nothing and charges nothing.
    expect(
      await prisma.tenantSubscription.count({
        where: { subscriberTenantId: FULL },
      }),
    ).toBe(0);
    const replay = await checkoutOf(full).checkout(
      submission,
      customer.id,
      tenant,
    );
    expect(replay.orderId).toBe(placed.orderId);
    expect(charge).toHaveBeenCalledTimes(1);
    expect(await balanceOf(customer.customerId)).toBe(85);
  });

  it('after a downgrade a NEW submission is evaluated again (a quote locks nothing), balances are kept, and earning resumes on re-entitlement', async () => {
    const code = `DOWN${run}`.toUpperCase();
    await coupon(FULL, code);
    const customer = await customerWithBeans(FULL, 'down-buyer', 40);
    const tenant = tenantContextFor(FULL);
    const lines = order(fullShop).lines;

    const quoted = await checkoutOf(full).quoteCheckout(
      { locationId: fullShop.locationId, lines, couponCode: code },
      customer.id,
      tenant,
    );
    expect(quoted).toMatchObject({
      couponStatus: 'applied',
      promotionsAvailable: true,
    });

    await unsubscribe(FULL);
    const submission = order(fullShop, { couponCode: code });
    await expectFeatureRefusal(
      checkoutOf(full).checkout(submission, customer.id, tenant),
      'promotions',
    );
    expect(await attemptFor(submission.idempotencyKey)).toBeNull();
    expect(await balanceOf(customer.customerId)).toBe(40);

    const unearned = await checkoutOf(full).checkout(
      order(fullShop),
      customer.id,
      tenant,
    );
    expect(unearned.orderId).toBeDefined();
    expect(await balanceOf(customer.customerId)).toBe(40);

    await subscribe(FULL);
    await checkoutOf(full).checkout(order(fullShop), customer.id, tenant);
    // $10.00 at 1 Bean per dollar.
    expect(await balanceOf(customer.customerId)).toBe(50);
  });
});
