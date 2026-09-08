import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminLoyaltyBonusPromotion,
  AdminLoyaltyBonusPromotionOptions,
  AdminLoyaltyBonusPromotionsResponse,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { LoyaltyModule } from './loyalty.module';

type Scope = { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null };

// Milestone 7D — HQ management of Bonus Mocha Beans Promotions, over real
// HTTP against local Postgres. Covers the CORPORATE-only `loyalty.configure`
// gate, the V1 validation rules, and that each config change writes exactly
// one InternalAuditEvent (targetType 'loyalty_bonus_promotion').
describe('Bonus Mocha Beans Promotions admin (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'bonus-promo-spec-internal-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const promotionIds: string[] = [];
  let locId: string;
  let otherLocId: string;
  let productAId: string;
  let productBId: string;

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
        key: `bonus-promo-spec-${suffix}-${randomUUID()}`,
        displayName: 'Bonus Promo Spec Role',
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
      .get('/api/v1/admin/loyalty/bonus-promotions')
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`);

  const getOptions = (key: string) =>
    request(app.getHttpServer())
      .get('/api/v1/admin/loyalty/bonus-promotion-options')
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`);

  const create = (key: string, body: unknown) =>
    request(app.getHttpServer())
      .post('/api/v1/admin/loyalty/bonus-promotions')
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  const patch = (key: string, id: string, body: unknown) =>
    request(app.getHttpServer())
      .patch(`/api/v1/admin/loyalty/bonus-promotions/${id}`)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  async function track(res: { body: unknown }): Promise<AdminLoyaltyBonusPromotion> {
    const promotion = res.body as AdminLoyaltyBonusPromotion;
    promotionIds.push(promotion.id);
    return promotion;
  }

  async function auditFor(promotionId: string) {
    return prisma.internalAuditEvent.findMany({
      where: {
        targetType: 'loyalty_bonus_promotion',
        targetId: promotionId,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  const validCreate = (over: Record<string, unknown> = {}) => ({
    name: `Promo ${randomUUID()}`,
    type: 'EXTRA_BEANS',
    bonusValue: 20,
    eligibleProductIds: [productAId],
    appliesToAllLocations: true,
    ...over,
  });

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'bonus-promo-spec-customer-secret';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, CustomerAuthModule, InternalAuthModule, LoyaltyModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    locId = (
      await prisma.location.create({
        data: {
          name: `Bonus Promo Loc ${suffix}`,
          slug: `bonus-promo-loc-${suffix}`,
          isActive: true,
        },
      })
    ).id;
    otherLocId = (
      await prisma.location.create({
        data: {
          name: `Bonus Promo Loc 2 ${suffix}`,
          slug: `bonus-promo-loc2-${suffix}`,
          isActive: true,
        },
      })
    ).id;

    const category = await prisma.category.create({
      data: { name: `Bonus Promo Cat ${suffix}`, slug: `bonus-promo-cat-${suffix}` },
    });
    productAId = (
      await prisma.product.create({
        data: {
          name: `Bonus Promo Matcha ${suffix}`,
          slug: `bonus-promo-matcha-${suffix}`,
          categoryId: category.id,
        },
      })
    ).id;
    productBId = (
      await prisma.product.create({
        data: {
          name: `Bonus Promo Latte ${suffix}`,
          slug: `bonus-promo-latte-${suffix}`,
          categoryId: category.id,
        },
      })
    ).id;

    await makeUserWithRole('hq', ['loyalty.configure'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUserWithRole('viewer', ['loyalty.view'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUserWithRole('locationScoped', ['loyalty.configure'], {
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
      await prisma.loyaltyBonusPromotionProduct.deleteMany({
        where: { promotionId: { in: promotionIds } },
      });
      await prisma.loyaltyBonusPromotionLocation.deleteMany({
        where: { promotionId: { in: promotionIds } },
      });
      await prisma.internalAuditEvent.deleteMany({
        where: {
          targetType: 'loyalty_bonus_promotion',
          targetId: { in: promotionIds },
        },
      });
      await prisma.loyaltyBonusPromotion.deleteMany({
        where: { id: { in: promotionIds } },
      });
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
    await prisma.product.deleteMany({
      where: { id: { in: [productAId, productBId] } },
    });
    await prisma.category.deleteMany({
      where: { slug: `bonus-promo-cat-${suffix}` },
    });
    await prisma.location.deleteMany({ where: { id: { in: [locId, otherLocId] } } });
    await app.close();
    process.env = { ...originalEnv };
  });

  // --- AUTH --------------------------------------------------

  it('a Store Manager cannot list or create bonus promotions', async () => {
    await list('storeMgr').expect(403);
    await create('storeMgr', validCreate()).expect(403);
  });

  it('a LOCATION-scoped loyalty.configure grant is rejected (CORPORATE-only)', async () => {
    await create('locationScoped', validCreate()).expect(403);
  });

  it('a loyalty.view-only corporate user cannot configure promotions', async () => {
    await list('viewer').expect(403);
  });

  it('a corporate loyalty.configure user can manage promotions', async () => {
    const res = await create('hq', validCreate()).expect(201);
    const promotion = await track(res);
    expect(promotion).toMatchObject({
      type: 'EXTRA_BEANS',
      bonusValue: 20,
      isActive: true,
      appliesToAllLocations: true,
    });
    expect(promotion.eligibleProducts.map((p) => p.id)).toEqual([productAId]);

    const listed = (await list('hq').expect(200))
      .body as AdminLoyaltyBonusPromotionsResponse;
    expect(listed.promotions.some((p) => p.id === promotion.id)).toBe(true);
  });

  it('bonus-promotion-options returns products and locations', async () => {
    const options = (await getOptions('hq').expect(200))
      .body as AdminLoyaltyBonusPromotionOptions;
    expect(options.products.some((p) => p.id === productAId)).toBe(true);
    expect(options.locations.some((l) => l.id === locId)).toBe(true);
  });

  // --- VALIDATION -------------------------------------------

  it('rejects a blank name', async () => {
    await create('hq', validCreate({ name: '   ' })).expect(400);
  });

  it('rejects EXTRA_BEANS outside 1..100000', async () => {
    await create('hq', validCreate({ type: 'EXTRA_BEANS', bonusValue: 0 })).expect(
      400,
    );
    await create(
      'hq',
      validCreate({ type: 'EXTRA_BEANS', bonusValue: 100_001 }),
    ).expect(400);
  });

  it('rejects a MULTIPLIER below 2 or above 10', async () => {
    await create('hq', validCreate({ type: 'MULTIPLIER', bonusValue: 1 })).expect(
      400,
    );
    await create('hq', validCreate({ type: 'MULTIPLIER', bonusValue: 11 })).expect(
      400,
    );
    const ok = await create(
      'hq',
      validCreate({ type: 'MULTIPLIER', bonusValue: 3 }),
    ).expect(201);
    await track(ok);
  });

  it('requires at least one eligible product', async () => {
    await create('hq', validCreate({ eligibleProductIds: [] })).expect(400);
  });

  it('rejects an eligible product that does not exist', async () => {
    await create(
      'hq',
      validCreate({ eligibleProductIds: [randomUUID()] }),
    ).expect(400);
  });

  it('requires all-locations or at least one valid selected location', async () => {
    await create(
      'hq',
      validCreate({ appliesToAllLocations: false, eligibleLocationIds: [] }),
    ).expect(400);
    await create(
      'hq',
      validCreate({
        appliesToAllLocations: false,
        eligibleLocationIds: [randomUUID()],
      }),
    ).expect(400);
    const ok = await create(
      'hq',
      validCreate({
        appliesToAllLocations: false,
        eligibleLocationIds: [locId],
      }),
    ).expect(201);
    const promotion = await track(ok);
    expect(promotion.appliesToAllLocations).toBe(false);
    expect(promotion.eligibleLocations.map((l) => l.id)).toEqual([locId]);
  });

  it('rejects an end date that is not after the start date', async () => {
    await create(
      'hq',
      validCreate({
        startsAt: '2026-10-01T00:00:00.000Z',
        endsAt: '2026-09-01T00:00:00.000Z',
      }),
    ).expect(400);
  });

  it("rejects changing a promotion's type", async () => {
    const promotion = await track(await create('hq', validCreate()).expect(201));
    await patch('hq', promotion.id, { type: 'MULTIPLIER' }).expect(400);
  });

  // --- AUDIT -----------------------------------------------

  it('writes exactly one audit event per config change', async () => {
    const promotion = await track(await create('hq', validCreate()).expect(201));
    let events = await auditFor(promotion.id);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('loyalty.bonus_promotion_created');

    await patch('hq', promotion.id, { bonusValue: 30 }).expect(200);
    await patch('hq', promotion.id, { isActive: false }).expect(200);
    await patch('hq', promotion.id, { isActive: true }).expect(200);

    events = await auditFor(promotion.id);
    expect(events.map((e) => e.action)).toEqual([
      'loyalty.bonus_promotion_created',
      'loyalty.bonus_promotion_updated',
      'loyalty.bonus_promotion_deactivated',
      'loyalty.bonus_promotion_activated',
    ]);
  });

  it('a no-op isActive patch writes an "updated" event, not a toggle event', async () => {
    const promotion = await track(await create('hq', validCreate()).expect(201));
    await patch('hq', promotion.id, { isActive: true, bonusValue: 25 }).expect(200);
    const events = await auditFor(promotion.id);
    expect(events.map((e) => e.action)).toEqual([
      'loyalty.bonus_promotion_created',
      'loyalty.bonus_promotion_updated',
    ]);
  });

  it('replacing the product and location lists works and is never a hard delete', async () => {
    const promotion = await track(
      await create(
        'hq',
        validCreate({ appliesToAllLocations: false, eligibleLocationIds: [locId] }),
      ).expect(201),
    );
    const updated = (
      await patch('hq', promotion.id, {
        eligibleProductIds: [productBId],
        eligibleLocationIds: [otherLocId],
      }).expect(200)
    ).body as AdminLoyaltyBonusPromotion;
    expect(updated.eligibleProducts.map((p) => p.id)).toEqual([productBId]);
    expect(updated.eligibleLocations.map((l) => l.id)).toEqual([otherLocId]);

    // The row still exists (deactivate, never delete).
    const still = await prisma.loyaltyBonusPromotion.findUnique({
      where: { id: promotion.id },
    });
    expect(still).not.toBeNull();
  });
});
