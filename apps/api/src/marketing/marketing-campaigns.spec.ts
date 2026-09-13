import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { AdminCampaign } from '@mocha-house/contracts';
import { CAMPAIGN_FEATURED_PRODUCTS_MAX } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { MediaModule } from '../media/media.module';
import { MarketingModule } from './marketing.module';

type Scope = { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null };

// Milestone 8G — HQ management of Marketing Campaigns over real HTTP. A
// campaign ORGANIZES existing Promotions / Bonus Mocha Bean Promotions /
// Products / Media; it never reimplements their rules. Covers the
// CORPORATE-only `marketing.view` / `marketing.manage` gates, validation,
// the DRAFT -> ACTIVE -> ENDED lifecycle (never mutating a linked record),
// media-deactivation protection, and audit events.
describe('Marketing Campaigns admin (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'marketing-admin-spec-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const campaignIds: string[] = [];
  const mediaAssetIds: string[] = [];
  const promotionIds: string[] = [];
  const bonusPromotionIds: string[] = [];
  const extraProductIds: string[] = [];
  let categoryId: string;
  let productActiveId: string;
  let productInactiveId: string;
  let hqUserId: string;
  let locId: string;

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}-${suffix}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );

  async function makeUserWithRole(
    key: string,
    permissionKeys: string[],
    scope: Scope,
  ): Promise<string> {
    const role = await prisma.internalRole.create({
      data: {
        key: `marketing-admin-${suffix}-${randomUUID()}`,
        displayName: 'Marketing Admin Spec Role',
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
    return user.id;
  }

  const list = (key: string, query = '') =>
    request(app.getHttpServer())
      .get(`/api/v1/admin/marketing/campaigns${query}`)
      .set('Authorization', `Bearer ${token(key)}`);

  const detail = (key: string, id: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/admin/marketing/campaigns/${id}`)
      .set('Authorization', `Bearer ${token(key)}`);

  const create = (key: string, body: unknown) =>
    request(app.getHttpServer())
      .post('/api/v1/admin/marketing/campaigns')
      .set('Authorization', `Bearer ${token(key)}`)
      .send(body as object);

  const patch = (key: string, id: string, body: unknown) =>
    request(app.getHttpServer())
      .patch(`/api/v1/admin/marketing/campaigns/${id}`)
      .set('Authorization', `Bearer ${token(key)}`)
      .send(body as object);

  const setStatus = (key: string, id: string, status: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/admin/marketing/campaigns/${id}/status`)
      .set('Authorization', `Bearer ${token(key)}`)
      .send({ status });

  const deactivateMedia = (key: string, mediaAssetId: string) =>
    request(app.getHttpServer())
      .post(`/api/v1/admin/media/${mediaAssetId}/deactivate`)
      .set('Authorization', `Bearer ${token(key)}`)
      .send({});

  function track(res: { body: unknown }): AdminCampaign {
    const campaign = res.body as AdminCampaign;
    campaignIds.push(campaign.id);
    return campaign;
  }

  async function makeMediaAsset(isActive: boolean): Promise<string> {
    const asset = await prisma.mediaAsset.create({
      data: {
        objectKey: `media/marketing-spec-${randomUUID()}.jpg`,
        fileName: 'campaign.jpg',
        contentType: 'image/jpeg',
        fileSizeBytes: 1024,
        isActive,
        uploadedByInternalUserId: hqUserId,
      },
    });
    mediaAssetIds.push(asset.id);
    return asset.id;
  }

  async function makePromotion(isActive: boolean): Promise<string> {
    const promotion = await prisma.promotion.create({
      data: {
        name: `Marketing Spec Promo ${randomUUID()}`,
        kind: 'AUTOMATIC',
        discountType: 'PERCENTAGE_OFF',
        discountValue: 10,
        appliesToAllLocations: true,
        isActive,
      },
    });
    promotionIds.push(promotion.id);
    return promotion.id;
  }

  async function makeBonusPromotion(isActive: boolean): Promise<string> {
    const promotion = await prisma.loyaltyBonusPromotion.create({
      data: {
        name: `Marketing Spec Bonus ${randomUUID()}`,
        type: 'EXTRA_BEANS',
        bonusValue: 5,
        appliesToAllLocations: true,
        isActive,
      },
    });
    bonusPromotionIds.push(promotion.id);
    return promotion.id;
  }

  async function auditFor(campaignId: string) {
    return prisma.internalAuditEvent.findMany({
      where: { targetType: 'campaign', targetId: campaignId },
      orderBy: { createdAt: 'asc' },
    });
  }

  const validCampaign = (over: Record<string, unknown> = {}) => ({
    name: `Campaign ${randomUUID()}`,
    ...over,
  });

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'marketing-admin-spec-customer-secret';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        MarketingModule,
        MediaModule,
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    locId = (
      await prisma.location.create({
        data: { name: `Marketing Loc ${suffix}`, slug: `marketing-loc-${suffix}` },
      })
    ).id;
    const category = await prisma.category.create({
      data: { name: `Marketing Cat ${suffix}`, slug: `marketing-cat-${suffix}` },
    });
    categoryId = category.id;
    productActiveId = (
      await prisma.product.create({
        data: {
          name: `Marketing Product Active ${suffix}`,
          slug: `marketing-product-active-${suffix}`,
          categoryId,
          isActive: true,
        },
      })
    ).id;
    productInactiveId = (
      await prisma.product.create({
        data: {
          name: `Marketing Product Inactive ${suffix}`,
          slug: `marketing-product-inactive-${suffix}`,
          categoryId,
          isActive: false,
        },
      })
    ).id;

    hqUserId = await makeUserWithRole(
      'hq',
      ['marketing.view', 'marketing.manage', 'media.view', 'media.manage'],
      { scopeType: 'CORPORATE', scopeId: null },
    );
    await makeUserWithRole('viewerOnly', ['marketing.view'], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUserWithRole('locationScoped', ['marketing.view', 'marketing.manage'], {
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

  afterAll(async () => {
    if (campaignIds.length > 0) {
      await prisma.campaignProduct.deleteMany({
        where: { campaignId: { in: campaignIds } },
      });
    }
    await prisma.internalAuditEvent.deleteMany({
      where: { targetType: 'campaign', targetId: { in: campaignIds } },
    });
    await prisma.campaign.deleteMany({ where: { id: { in: campaignIds } } });
    await prisma.promotion.deleteMany({ where: { id: { in: promotionIds } } });
    await prisma.loyaltyBonusPromotion.deleteMany({
      where: { id: { in: bonusPromotionIds } },
    });
    await prisma.mediaAsset.deleteMany({ where: { id: { in: mediaAssetIds } } });
    await prisma.product.deleteMany({
      where: { id: { in: [productActiveId, productInactiveId, ...extraProductIds] } },
    });
    await prisma.category.deleteMany({ where: { id: categoryId } });
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    await prisma.internalRolePermission.deleteMany({
      where: { roleId: { in: roleIds } },
    });
    await prisma.internalRole.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.location.deleteMany({ where: { id: locId } });
    await app.close();
    await prisma.$disconnect();
    process.env = { ...originalEnv };
  }, 30_000);

  // --- authorization -------------------------------------------

  it('rejects an unauthenticated request', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/marketing/campaigns')
      .expect(401);
  });

  it('marketing.view can list/detail/options but not create', async () => {
    await list('viewerOnly').expect(200);
    const created = track(await create('hq', validCampaign()).expect(201));
    await detail('viewerOnly', created.id).expect(200);
    await create('viewerOnly', validCampaign()).expect(403);
  });

  it('a LOCATION-scoped grant of marketing.manage is rejected (CORPORATE-only)', async () => {
    await create('locationScoped', validCampaign()).expect(403);
    await list('locationScoped').expect(403);
  });

  it('a Store Manager (no marketing permission) is rejected', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/marketing/campaigns')
      .set('Authorization', `Bearer ${token('storeMgr')}`)
      .expect(403);
  });

  // --- create / update -------------------------------------------

  it('creates a DRAFT campaign with the minimum fields', async () => {
    const res = await create('hq', validCampaign()).expect(201);
    const campaign = track(res);
    expect(campaign.status).toBe('DRAFT');
    expect(campaign.promotion).toBeNull();
    expect(campaign.loyaltyBonusPromotion).toBeNull();
    expect(campaign.featuredProducts).toEqual([]);
  });

  it('accepts both a Promotion and a LoyaltyBonusPromotion simultaneously', async () => {
    const promotionId = await makePromotion(true);
    const loyaltyBonusPromotionId = await makeBonusPromotion(true);
    const campaign = track(
      await create('hq', validCampaign({ promotionId, loyaltyBonusPromotionId })).expect(
        201,
      ),
    );
    expect(campaign.promotion?.id).toBe(promotionId);
    expect(campaign.loyaltyBonusPromotion?.id).toBe(loyaltyBonusPromotionId);
  });

  it('rejects an end date not after the start date', async () => {
    await create(
      'hq',
      validCampaign({ startsAt: '2026-06-01T00:00:00.000Z', endsAt: '2026-05-01T00:00:00.000Z' }),
    ).expect(400);
  });

  it('rejects a non-existent promotion / bonus promotion / media asset', async () => {
    await create('hq', validCampaign({ promotionId: randomUUID() })).expect(400);
    await create('hq', validCampaign({ loyaltyBonusPromotionId: randomUUID() })).expect(
      400,
    );
    await create('hq', validCampaign({ mediaAssetId: randomUUID() })).expect(400);
  });

  it('rejects an inactive media asset at create/update time', async () => {
    const inactiveMediaId = await makeMediaAsset(false);
    await create('hq', validCampaign({ mediaAssetId: inactiveMediaId })).expect(400);
  });

  it('accepts a currently-inactive Promotion / LoyaltyBonusPromotion at create/update time (only existence is required)', async () => {
    const promotionId = await makePromotion(false);
    const loyaltyBonusPromotionId = await makeBonusPromotion(false);
    const campaign = track(
      await create('hq', validCampaign({ promotionId, loyaltyBonusPromotionId })).expect(
        201,
      ),
    );
    expect(campaign.promotion?.isActive).toBe(false);
    expect(campaign.loyaltyBonusPromotion?.isActive).toBe(false);
  });

  it('rejects an inactive featured product', async () => {
    await create(
      'hq',
      validCampaign({ featuredProductIds: [productInactiveId] }),
    ).expect(400);
  });

  it('rejects duplicate featured product ids', async () => {
    await create(
      'hq',
      validCampaign({ featuredProductIds: [productActiveId, productActiveId] }),
    ).expect(400);
  });

  it(`rejects more than ${CAMPAIGN_FEATURED_PRODUCTS_MAX} featured products and accepts exactly ${CAMPAIGN_FEATURED_PRODUCTS_MAX}`, async () => {
    const productIds: string[] = [];
    for (let i = 0; i < CAMPAIGN_FEATURED_PRODUCTS_MAX + 1; i += 1) {
      const id = (
        await prisma.product.create({
          data: {
            name: `Marketing Cap Product ${i} ${suffix}`,
            slug: `marketing-cap-product-${i}-${suffix}`,
            categoryId,
            isActive: true,
          },
        })
      ).id;
      extraProductIds.push(id);
      productIds.push(id);
    }

    await create(
      'hq',
      validCampaign({ featuredProductIds: productIds }),
    ).expect(400);

    const campaign = track(
      await create(
        'hq',
        validCampaign({
          featuredProductIds: productIds.slice(0, CAMPAIGN_FEATURED_PRODUCTS_MAX),
        }),
      ).expect(201),
    );
    expect(campaign.featuredProducts).toHaveLength(CAMPAIGN_FEATURED_PRODUCTS_MAX);
  });

  it('persists deterministic featured-product display order and lets update replace it', async () => {
    const productB = (
      await prisma.product.create({
        data: {
          name: `Marketing Product B ${suffix}`,
          slug: `marketing-product-b-${suffix}`,
          categoryId,
          isActive: true,
        },
      })
    ).id;
    extraProductIds.push(productB);

    const campaign = track(
      await create(
        'hq',
        validCampaign({ featuredProductIds: [productB, productActiveId] }),
      ).expect(201),
    );
    expect(campaign.featuredProducts.map((p) => p.id)).toEqual([
      productB,
      productActiveId,
    ]);

    const updated = (
      await patch('hq', campaign.id, {
        featuredProductIds: [productActiveId, productB],
      }).expect(200)
    ).body as AdminCampaign;
    expect(updated.featuredProducts.map((p) => p.id)).toEqual([
      productActiveId,
      productB,
    ]);
  });

  it('rejects a status write smuggled through PATCH', async () => {
    const campaign = track(await create('hq', validCampaign()).expect(201));
    await patch('hq', campaign.id, { status: 'ACTIVE' }).expect(400);
  });

  it('rejects editing an ENDED campaign', async () => {
    const campaign = track(await create('hq', validCampaign()).expect(201));
    await setStatus('hq', campaign.id, 'ACTIVE').expect(201);
    await setStatus('hq', campaign.id, 'ENDED').expect(201);
    await patch('hq', campaign.id, { name: 'New name' }).expect(409);
  });

  // --- status lifecycle -------------------------------------------

  it('moves DRAFT -> ACTIVE -> ENDED and rejects invalid transitions', async () => {
    const campaign = track(await create('hq', validCampaign()).expect(201));
    await setStatus('hq', campaign.id, 'ENDED').expect(409); // DRAFT -> ENDED invalid
    const active = (
      await setStatus('hq', campaign.id, 'ACTIVE').expect(201)
    ).body as AdminCampaign;
    expect(active.status).toBe('ACTIVE');
    await setStatus('hq', campaign.id, 'ACTIVE').expect(409); // re-activation invalid
    const ended = (
      await setStatus('hq', campaign.id, 'ENDED').expect(201)
    ).body as AdminCampaign;
    expect(ended.status).toBe('ENDED');
    await setStatus('hq', campaign.id, 'ACTIVE').expect(409); // ENDED is terminal
  });

  it('activation revalidates a linked Promotion and never mutates it', async () => {
    const promotionId = await makePromotion(false); // inactive
    const campaign = track(
      await create('hq', validCampaign({ promotionId })).expect(201),
    );
    await setStatus('hq', campaign.id, 'ACTIVE').expect(409);

    const promotion = await prisma.promotion.findUniqueOrThrow({
      where: { id: promotionId },
    });
    expect(promotion.isActive).toBe(false); // untouched by the failed activation

    await prisma.promotion.update({ where: { id: promotionId }, data: { isActive: true } });
    const activated = (
      await setStatus('hq', campaign.id, 'ACTIVE').expect(201)
    ).body as AdminCampaign;
    expect(activated.status).toBe('ACTIVE');

    const promotionAfter = await prisma.promotion.findUniqueOrThrow({
      where: { id: promotionId },
    });
    expect(promotionAfter.isActive).toBe(true);
    expect(promotionAfter.name).toBe(promotion.name); // never mutated by the campaign
  });

  it('activation revalidates a linked LoyaltyBonusPromotion and never mutates it', async () => {
    const loyaltyBonusPromotionId = await makeBonusPromotion(false);
    const campaign = track(
      await create('hq', validCampaign({ loyaltyBonusPromotionId })).expect(201),
    );
    await setStatus('hq', campaign.id, 'ACTIVE').expect(409);
    const bonus = await prisma.loyaltyBonusPromotion.findUniqueOrThrow({
      where: { id: loyaltyBonusPromotionId },
    });
    expect(bonus.isActive).toBe(false);
  });

  it('activation revalidates linked media and featured products', async () => {
    const mediaAssetId = await makeMediaAsset(true);
    const campaign = track(
      await create('hq', validCampaign({ mediaAssetId, featuredProductIds: [productActiveId] })).expect(
        201,
      ),
    );
    // Deactivate the product out from under the (still DRAFT) campaign.
    await prisma.product.update({
      where: { id: productActiveId },
      data: { isActive: false },
    });
    await setStatus('hq', campaign.id, 'ACTIVE').expect(409);
    await prisma.product.update({
      where: { id: productActiveId },
      data: { isActive: true },
    });

    // Deactivate the media asset out from under the (still DRAFT) campaign.
    await prisma.mediaAsset.update({
      where: { id: mediaAssetId },
      data: { isActive: false },
    });
    await setStatus('hq', campaign.id, 'ACTIVE').expect(409);
    await prisma.mediaAsset.update({
      where: { id: mediaAssetId },
      data: { isActive: true },
    });

    await setStatus('hq', campaign.id, 'ACTIVE').expect(201);
  });

  // --- media protection -------------------------------------------

  it('refuses to deactivate a media asset referenced by a campaign (409), asset stays active', async () => {
    const mediaAssetId = await makeMediaAsset(true);
    track(await create('hq', validCampaign({ mediaAssetId })).expect(201));

    await deactivateMedia('hq', mediaAssetId).expect(409);

    const asset = await prisma.mediaAsset.findUniqueOrThrow({
      where: { id: mediaAssetId },
    });
    expect(asset.isActive).toBe(true);
  });

  // --- audit -------------------------------------------------------

  it('records compact audit events for create, update and status change', async () => {
    const campaign = track(await create('hq', validCampaign()).expect(201));
    await patch('hq', campaign.id, { name: 'Renamed campaign' }).expect(200);
    await setStatus('hq', campaign.id, 'ACTIVE').expect(201);

    const events = await auditFor(campaign.id);
    const actions = events.map((e) => e.action);
    expect(actions).toEqual([
      'marketing.campaign_created',
      'marketing.campaign_updated',
      'marketing.campaign_status_changed',
    ]);

    const statusEvent = events[2]!;
    expect(statusEvent.beforeData).toEqual({ status: 'DRAFT' });
    expect(statusEvent.afterData).toEqual({ status: 'ACTIVE' });

    // No PII, no large content body — audit carries compact config only.
    const createdEvent = events[0]!;
    const snapshot = createdEvent.afterData as Record<string, unknown>;
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        'name',
        'description',
        'status',
        'startsAt',
        'endsAt',
        'mediaAssetId',
        'promotionId',
        'loyaltyBonusPromotionId',
        'featuredProductIds',
      ].sort(),
    );
  });
});
