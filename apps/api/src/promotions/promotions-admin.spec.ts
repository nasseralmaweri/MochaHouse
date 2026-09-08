import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminPromotion,
  AdminPromotionOptions,
  AdminPromotionsResponse,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { PromotionsModule } from './promotions.module';

type Scope = { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null };

// Milestone 7E — HQ management of Promotions & Coupons over real HTTP.
// Covers the CORPORATE-only `promotions.configure` gate, the V1 validation
// rules, case-insensitive coupon-code uniqueness, and audit events.
describe('Promotions & Coupons admin (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'promo-admin-spec-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const promotionIds: string[] = [];
  let locId: string;
  let otherLocId: string;
  let productAId: string;
  let categoryId: string;

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );

  async function makeUserWithRole(
    key: string,
    permissionKeys: string[],
    scope: Scope,
  ): Promise<void> {
    const role = await prisma.internalRole.create({
      data: {
        key: `promo-admin-${suffix}-${randomUUID()}`,
        displayName: 'Promo Admin Spec Role',
        permissions: {
          create: permissionKeys.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    roleIds.push(role.id);
    const user = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${key}-${suffix}`,
        email: `${key}-${suffix}@example.com`,
        displayName: key,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(user.id);
    await prisma.internalUserRoleAssignment.create({
      data: { internalUserId: user.id, roleId: role.id, ...scope },
    });
  }

  const list = (key: string) =>
    request(app.getHttpServer())
      .get('/api/v1/admin/promotions')
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`);

  const create = (key: string, body: unknown) =>
    request(app.getHttpServer())
      .post('/api/v1/admin/promotions')
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  const patch = (key: string, id: string, body: unknown) =>
    request(app.getHttpServer())
      .patch(`/api/v1/admin/promotions/${id}`)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  async function track(res: { body: unknown }): Promise<AdminPromotion> {
    const promotion = res.body as AdminPromotion;
    promotionIds.push(promotion.id);
    return promotion;
  }

  async function auditFor(promotionId: string) {
    return prisma.internalAuditEvent.findMany({
      where: { targetType: 'promotion', targetId: promotionId },
      orderBy: { createdAt: 'asc' },
    });
  }

  const validAutomatic = (over: Record<string, unknown> = {}) => ({
    name: `Promo ${randomUUID()}`,
    kind: 'AUTOMATIC',
    discountType: 'PERCENTAGE_OFF',
    discountValue: 20,
    appliesToAllLocations: true,
    ...over,
  });

  const validCoupon = (over: Record<string, unknown> = {}) => ({
    name: `Coupon ${randomUUID()}`,
    kind: 'COUPON',
    code: `SAVE${Math.floor(Math.random() * 1e6)}`,
    discountType: 'FIXED_AMOUNT',
    discountValue: 500,
    appliesToAllLocations: true,
    ...over,
  });

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'promo-admin-spec-customer-secret';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        PromotionsModule,
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    locId = (
      await prisma.location.create({
        data: { name: `Promo Loc ${suffix}`, slug: `promo-loc-${suffix}` },
      })
    ).id;
    otherLocId = (
      await prisma.location.create({
        data: { name: `Promo Loc 2 ${suffix}`, slug: `promo-loc2-${suffix}` },
      })
    ).id;
    const category = await prisma.category.create({
      data: { name: `Promo Cat ${suffix}`, slug: `promo-cat-${suffix}` },
    });
    categoryId = category.id;
    productAId = (
      await prisma.product.create({
        data: {
          name: `Promo Product ${suffix}`,
          slug: `promo-product-${suffix}`,
          categoryId: category.id,
        },
      })
    ).id;

    await makeUserWithRole('hq', ['promotions.configure'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUserWithRole('locationScoped', ['promotions.configure'], {
      scopeType: 'LOCATION',
      scopeId: locId,
    });
    const storeManager = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'store-manager' },
    });
    const mgr = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:storeMgr-${suffix}`,
        email: `storeMgr-${suffix}@example.com`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(mgr.id);
    await prisma.internalUserRoleAssignment.create({
      data: {
        internalUserId: mgr.id,
        roleId: storeManager.id,
        scopeType: 'LOCATION',
        scopeId: locId,
      },
    });
  }, 45_000);

  afterEach(async () => {
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
      await prisma.internalAuditEvent.deleteMany({
        where: { targetType: 'promotion', targetId: { in: promotionIds } },
      });
      await prisma.promotion.deleteMany({ where: { id: { in: promotionIds } } });
      promotionIds.length = 0;
    }
  });

  afterAll(async () => {
    await prisma.internalAuditEvent.deleteMany({
      where: { actorInternalUserId: { in: userIds } },
    });
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    for (const id of roleIds) {
      await prisma.internalRolePermission.deleteMany({ where: { roleId: id } });
      await prisma.internalRole.deleteMany({ where: { id } });
    }
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.product.deleteMany({ where: { id: productAId } });
    await prisma.category.deleteMany({ where: { id: categoryId } });
    await prisma.location.deleteMany({
      where: { id: { in: [locId, otherLocId] } },
    });
    await app.close();
    process.env = { ...originalEnv };
  });

  // --- AUTH -------------------------------------------------

  it('a Store Manager cannot list or create promotions', async () => {
    await list('storeMgr').expect(403);
    await create('storeMgr', validAutomatic()).expect(403);
  });

  it('a LOCATION-scoped promotions.configure grant is rejected (CORPORATE-only)', async () => {
    await create('locationScoped', validAutomatic()).expect(403);
  });

  it('a corporate promotions.configure user can manage promotions', async () => {
    const promotion = await track(
      await create('hq', validAutomatic()).expect(201),
    );
    expect(promotion).toMatchObject({
      kind: 'AUTOMATIC',
      discountType: 'PERCENTAGE_OFF',
      discountValue: 20,
      isActive: true,
      code: null,
    });
    const listed = (await list('hq').expect(200))
      .body as AdminPromotionsResponse;
    expect(listed.promotions.some((p) => p.id === promotion.id)).toBe(true);

    const options = (
      await request(app.getHttpServer())
        .get('/api/v1/admin/promotions/options')
        .set('Authorization', `Bearer ${token(`hq-${suffix}`)}`)
        .expect(200)
    ).body as AdminPromotionOptions;
    expect(options.products.some((p) => p.id === productAId)).toBe(true);
    expect(options.locations.some((l) => l.id === locId)).toBe(true);
  });

  // --- COUPON CODE -----------------------------------------

  it('normalizes a coupon code and enforces case-insensitive uniqueness', async () => {
    const code = `WELCOME${Math.floor(Math.random() * 1e6)}`;
    const promotion = await track(
      await create('hq', validCoupon({ code: code.toLowerCase() })).expect(201),
    );
    expect(promotion.code).toBe(code.toUpperCase());

    // Same code, different case -> 409.
    await create(
      'hq',
      validCoupon({ code: code.toUpperCase() }),
    ).expect(409);
  });

  it('rejects a coupon with no code and an automatic promotion with a code', async () => {
    await create('hq', validCoupon({ code: undefined })).expect(400);
    await create('hq', validAutomatic({ code: 'NOPE123' })).expect(400);
  });

  it('rejects a malformed coupon code', async () => {
    await create('hq', validCoupon({ code: 'ab' })).expect(400); // too short
    await create('hq', validCoupon({ code: 'has space' })).expect(400);
  });

  // --- VALIDATION -----------------------------------------

  it('rejects percentage outside 1..100', async () => {
    await create('hq', validAutomatic({ discountValue: 0 })).expect(400);
    await create('hq', validAutomatic({ discountValue: 101 })).expect(400);
  });

  it('rejects a non-positive fixed amount', async () => {
    await create(
      'hq',
      validAutomatic({ discountType: 'FIXED_AMOUNT', discountValue: 0 }),
    ).expect(400);
  });

  it('a FREE_ITEM promotion must target products or categories', async () => {
    await create(
      'hq',
      validAutomatic({ discountType: 'FREE_ITEM', applicability: 'ENTIRE_ORDER' }),
    ).expect(400);
    const ok = await create(
      'hq',
      validAutomatic({
        discountType: 'FREE_ITEM',
        applicability: 'SELECTED_PRODUCTS',
        eligibleProductIds: [productAId],
      }),
    ).expect(201);
    await track(ok);
  });

  it('SELECTED_PRODUCTS needs at least one valid product', async () => {
    await create(
      'hq',
      validAutomatic({ applicability: 'SELECTED_PRODUCTS', eligibleProductIds: [] }),
    ).expect(400);
    await create(
      'hq',
      validAutomatic({
        applicability: 'SELECTED_PRODUCTS',
        eligibleProductIds: [randomUUID()],
      }),
    ).expect(400);
  });

  it('requires all-locations or at least one valid selected location', async () => {
    await create(
      'hq',
      validAutomatic({ appliesToAllLocations: false, eligibleLocationIds: [] }),
    ).expect(400);
    const ok = await create(
      'hq',
      validAutomatic({
        appliesToAllLocations: false,
        eligibleLocationIds: [locId],
      }),
    ).expect(201);
    const promotion = await track(ok);
    expect(promotion.eligibleLocations.map((l) => l.id)).toEqual([locId]);
  });

  it('rejects an end date that is not after the start date', async () => {
    await create(
      'hq',
      validAutomatic({
        startsAt: '2026-10-01T00:00:00.000Z',
        endsAt: '2026-09-01T00:00:00.000Z',
      }),
    ).expect(400);
  });

  it("rejects changing a promotion's kind or discount type", async () => {
    const promotion = await track(
      await create('hq', validAutomatic()).expect(201),
    );
    await patch('hq', promotion.id, { kind: 'COUPON' }).expect(400);
    await patch('hq', promotion.id, { discountType: 'FIXED_AMOUNT' }).expect(400);
  });

  // --- AUDIT ----------------------------------------------

  it('writes exactly one audit event per config change', async () => {
    const promotion = await track(
      await create('hq', validAutomatic()).expect(201),
    );
    await patch('hq', promotion.id, { discountValue: 30 }).expect(200);
    await patch('hq', promotion.id, { isActive: false }).expect(200);
    await patch('hq', promotion.id, { isActive: true }).expect(200);

    const events = await auditFor(promotion.id);
    expect(events.map((e) => e.action)).toEqual([
      'promotions.promotion_created',
      'promotions.promotion_updated',
      'promotions.promotion_deactivated',
      'promotions.promotion_activated',
    ]);
  });

  it('replacing product / location lists never hard-deletes the promotion', async () => {
    const promotion = await track(
      await create(
        'hq',
        validAutomatic({
          applicability: 'SELECTED_PRODUCTS',
          eligibleProductIds: [productAId],
          appliesToAllLocations: false,
          eligibleLocationIds: [locId],
        }),
      ).expect(201),
    );
    await patch('hq', promotion.id, {
      eligibleLocationIds: [otherLocId],
    }).expect(200);
    const still = await prisma.promotion.findUnique({
      where: { id: promotion.id },
    });
    expect(still).not.toBeNull();
  });
});
