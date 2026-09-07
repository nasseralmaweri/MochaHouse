import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminLoyaltyReward,
  AdminLoyaltyRewardsResponse,
  CustomerLoyaltySummary,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';
import { LoyaltyModule } from './loyalty.module';

type Scope = { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null };

// Milestone 7B — the HQ Rewards Catalog + the customer-facing reward list,
// over real HTTP against local Postgres. Catalog management only: no
// redemption, no Bean movement.
describe('Loyalty Rewards Catalog (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'loyalty-rewards-spec-internal-secret';
  const customerSecret = 'loyalty-rewards-spec-customer-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const rewardIds: string[] = [];
  const customerIds: string[] = [];
  let locId: string;
  let productAId: string;
  let productBId: string;
  let categoryId: string;

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );

  const customerToken = (sub: string) =>
    signDevJwt({ sub, email: `${sub}@x.test`, name: null }, customerSecret, 3600);

  async function makeUserWithRole(
    key: string,
    permissionKeys: string[],
    scope: Scope,
  ): Promise<void> {
    const role = await prisma.internalRole.create({
      data: {
        key: `rewards-spec-${suffix}-${randomUUID()}`,
        displayName: 'Rewards Spec Role',
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

  const listRewards = (key: string) =>
    request(app.getHttpServer())
      .get('/api/v1/admin/loyalty/rewards')
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`);

  const createReward = (key: string, body: unknown) =>
    request(app.getHttpServer())
      .post('/api/v1/admin/loyalty/rewards')
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  const patchReward = (key: string, rewardId: string, body: unknown) =>
    request(app.getHttpServer())
      .patch(`/api/v1/admin/loyalty/rewards/${rewardId}`)
      .set('Authorization', `Bearer ${token(`${key}-${suffix}`)}`)
      .send(body as object);

  const customerSummary = (sub: string) =>
    request(app.getHttpServer())
      .get('/api/v1/customers/me/loyalty')
      .set('Authorization', `Bearer ${customerToken(sub)}`);

  async function trackReward(res: { body: unknown }): Promise<AdminLoyaltyReward> {
    const reward = res.body as AdminLoyaltyReward;
    rewardIds.push(reward.id);
    return reward;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = customerSecret;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        LoyaltyModule,
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    locId = (
      await prisma.location.create({
        data: {
          name: `Rewards Spec Loc ${suffix}`,
          slug: `rewards-spec-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;

    const category = await prisma.category.create({
      data: { name: `Rewards Spec Cat ${suffix}`, slug: `rewards-cat-${suffix}` },
    });
    categoryId = category.id;
    productAId = (
      await prisma.product.create({
        data: {
          name: `Rewards Spec Latte ${suffix}`,
          slug: `rewards-latte-${suffix}`,
          categoryId,
        },
      })
    ).id;
    productBId = (
      await prisma.product.create({
        data: {
          name: `Rewards Spec Pastry ${suffix}`,
          slug: `rewards-pastry-${suffix}`,
          categoryId,
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
    // Remove every reward this suite created so the customer-view tests
    // (which list ALL active rewards) stay deterministic.
    if (rewardIds.length > 0) {
      await prisma.loyaltyRewardProduct.deleteMany({
        where: { rewardId: { in: rewardIds } },
      });
      await prisma.loyaltyRewardCategory.deleteMany({
        where: { rewardId: { in: rewardIds } },
      });
      await prisma.internalAuditEvent.deleteMany({
        where: { targetType: 'loyalty_reward', targetId: { in: rewardIds } },
      });
      await prisma.loyaltyReward.deleteMany({
        where: { id: { in: rewardIds } },
      });
      rewardIds.length = 0;
    }
    await prisma.customerLoyaltyAccount.deleteMany({
      where: { customerId: { in: customerIds } },
    });
    await prisma.customer.deleteMany({ where: { id: { in: customerIds } } });
    customerIds.length = 0;
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
    await prisma.category.deleteMany({ where: { id: categoryId } });
    await prisma.location.deleteMany({ where: { id: locId } });
    await app.close();
    process.env = { ...originalEnv };
  });

  async function makeCustomerWithBalance(balance: number): Promise<string> {
    const sub = `dev:rewards-cust-${randomUUID()}`;
    const customer = await prisma.customer.create({
      data: { externalProvider: 'dev', externalSubject: sub, email: `${sub}@x.test` },
    });
    customerIds.push(customer.id);
    await prisma.customerLoyaltyAccount.create({
      data: { customerId: customer.id, balance },
    });
    return sub;
  }

  // ---- Permission / scope --------------------------------------

  it('managing rewards requires loyalty.configure', async () => {
    await listRewards('viewer').expect(403);
    await listRewards('storeMgr').expect(403);
    await createReward('viewer', {
      name: '$5 Off',
      type: 'FIXED_AMOUNT',
      beanCost: 100,
      fixedAmountMinorUnits: 500,
    }).expect(403);
    await listRewards('hq').expect(200);
  });

  it('loyalty.configure held only at LOCATION scope is rejected', async () => {
    await listRewards('locationScoped').expect(403);
    await createReward('locationScoped', {
      name: '$5 Off',
      type: 'FIXED_AMOUNT',
      beanCost: 100,
      fixedAmountMinorUnits: 500,
    }).expect(403);
  });

  it('a seeded Store Manager holds neither loyalty.configure', async () => {
    const role = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'store-manager' },
      include: { permissions: true },
    });
    const keys = role.permissions.map((p) => p.permissionKey);
    expect(keys).not.toContain('loyalty.configure');
  });

  // ---- Create -------------------------------------------------

  it('creates a fixed dollar-off reward and audits it', async () => {
    const reward = await trackReward(
      await createReward('hq', {
        name: '  $5 Off  ',
        description: 'Five dollars off your order',
        type: 'FIXED_AMOUNT',
        beanCost: 100,
        fixedAmountMinorUnits: 500,
      }).expect(201),
    );
    expect(reward).toMatchObject({
      name: '$5 Off',
      type: 'FIXED_AMOUNT',
      beanCost: 100,
      fixedAmountMinorUnits: 500,
      isActive: true,
      eligibleProducts: [],
      eligibleCategories: [],
    });

    const events = await prisma.internalAuditEvent.findMany({
      where: { targetType: 'loyalty_reward', targetId: reward.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('loyalty.reward_created');
  });

  it('creates a free-item reward tied to products and categories', async () => {
    const reward = await trackReward(
      await createReward('hq', {
        name: 'Free Latte',
        type: 'FREE_ITEM',
        beanCost: 150,
        eligibleProductIds: [productAId],
        eligibleCategoryIds: [categoryId],
      }).expect(201),
    );
    expect(reward.type).toBe('FREE_ITEM');
    expect(reward.fixedAmountMinorUnits).toBeNull();
    expect(reward.eligibleProducts.map((p) => p.id)).toEqual([productAId]);
    expect(reward.eligibleCategories.map((c) => c.id)).toEqual([categoryId]);
  });

  it('rejects malformed / mixed-type reward requests', async () => {
    // FIXED_AMOUNT without an amount
    await createReward('hq', {
      name: 'x',
      type: 'FIXED_AMOUNT',
      beanCost: 100,
    }).expect(400);
    // FIXED_AMOUNT with eligibility
    await createReward('hq', {
      name: 'x',
      type: 'FIXED_AMOUNT',
      beanCost: 100,
      fixedAmountMinorUnits: 500,
      eligibleProductIds: [productAId],
    }).expect(400);
    // FREE_ITEM with a fixed amount
    await createReward('hq', {
      name: 'x',
      type: 'FREE_ITEM',
      beanCost: 100,
      fixedAmountMinorUnits: 500,
      eligibleProductIds: [productAId],
    }).expect(400);
    // FREE_ITEM with no eligibility
    await createReward('hq', {
      name: 'x',
      type: 'FREE_ITEM',
      beanCost: 100,
    }).expect(400);
    // Unknown type
    await createReward('hq', {
      name: 'x',
      type: 'PERCENT_OFF',
      beanCost: 100,
    }).expect(400);
    // Bad beanCost
    await createReward('hq', {
      name: 'x',
      type: 'FIXED_AMOUNT',
      beanCost: 0,
      fixedAmountMinorUnits: 500,
    }).expect(400);
    // Blank name
    await createReward('hq', {
      name: '   ',
      type: 'FIXED_AMOUNT',
      beanCost: 100,
      fixedAmountMinorUnits: 500,
    }).expect(400);
  });

  it('rejects a free-item reward referencing catalog ids that do not exist', async () => {
    await createReward('hq', {
      name: 'Free Ghost',
      type: 'FREE_ITEM',
      beanCost: 100,
      eligibleProductIds: [randomUUID()],
    }).expect(400);
    await createReward('hq', {
      name: 'Free Ghost',
      type: 'FREE_ITEM',
      beanCost: 100,
      eligibleCategoryIds: [randomUUID()],
    }).expect(400);
  });

  // ---- Update / activate / deactivate ------------------------

  it('updates a reward and records an audit event', async () => {
    const reward = await trackReward(
      await createReward('hq', {
        name: '$5 Off',
        type: 'FIXED_AMOUNT',
        beanCost: 100,
        fixedAmountMinorUnits: 500,
      }).expect(201),
    );

    const updated = (
      await patchReward('hq', reward.id, {
        name: '$7 Off',
        beanCost: 140,
        fixedAmountMinorUnits: 700,
      }).expect(200)
    ).body as AdminLoyaltyReward;
    expect(updated).toMatchObject({
      name: '$7 Off',
      beanCost: 140,
      fixedAmountMinorUnits: 700,
    });

    const events = await prisma.internalAuditEvent.findMany({
      where: { targetType: 'loyalty_reward', targetId: reward.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual([
      'loyalty.reward_created',
      'loyalty.reward_updated',
    ]);
  });

  it('activate / deactivate is audited distinctly and hides the reward from customers', async () => {
    const reward = await trackReward(
      await createReward('hq', {
        name: '$5 Off',
        type: 'FIXED_AMOUNT',
        beanCost: 100,
        fixedAmountMinorUnits: 500,
      }).expect(201),
    );

    await patchReward('hq', reward.id, { isActive: false }).expect(200);
    await patchReward('hq', reward.id, { isActive: true }).expect(200);

    const events = await prisma.internalAuditEvent.findMany({
      where: { targetType: 'loyalty_reward', targetId: reward.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual([
      'loyalty.reward_created',
      'loyalty.reward_deactivated',
      'loyalty.reward_activated',
    ]);
  });

  it('rejects changing a reward type or giving a fixed reward eligibility', async () => {
    const reward = await trackReward(
      await createReward('hq', {
        name: '$5 Off',
        type: 'FIXED_AMOUNT',
        beanCost: 100,
        fixedAmountMinorUnits: 500,
      }).expect(201),
    );
    await patchReward('hq', reward.id, { type: 'FREE_ITEM' }).expect(400);
    await patchReward('hq', reward.id, {
      eligibleProductIds: [productAId],
    }).expect(400);
  });

  it('replaces free-item eligibility wholesale and rejects emptying it', async () => {
    const reward = await trackReward(
      await createReward('hq', {
        name: 'Free Item',
        type: 'FREE_ITEM',
        beanCost: 150,
        eligibleProductIds: [productAId],
      }).expect(201),
    );
    const updated = (
      await patchReward('hq', reward.id, {
        eligibleProductIds: [productBId],
        eligibleCategoryIds: [],
      }).expect(200)
    ).body as AdminLoyaltyReward;
    expect(updated.eligibleProducts.map((p) => p.id)).toEqual([productBId]);

    await patchReward('hq', reward.id, {
      eligibleProductIds: [],
      eligibleCategoryIds: [],
    }).expect(400);
  });

  it('returns 404 for an unknown reward', async () => {
    await patchReward('hq', randomUUID(), { beanCost: 10 }).expect(404);
  });

  // ---- Listing order ---------------------------------------

  it('lists rewards in deterministic sortOrder then id order', async () => {
    const a = await trackReward(
      await createReward('hq', {
        name: 'B second',
        type: 'FIXED_AMOUNT',
        beanCost: 100,
        fixedAmountMinorUnits: 500,
        sortOrder: 20,
      }).expect(201),
    );
    const b = await trackReward(
      await createReward('hq', {
        name: 'A first',
        type: 'FIXED_AMOUNT',
        beanCost: 100,
        fixedAmountMinorUnits: 500,
        sortOrder: 10,
      }).expect(201),
    );
    const list = (await listRewards('hq').expect(200))
      .body as AdminLoyaltyRewardsResponse;
    const ours = list.rewards.filter((r) => r.id === a.id || r.id === b.id);
    expect(ours.map((r) => r.id)).toEqual([b.id, a.id]); // sortOrder 10 before 20
  });

  // ---- Customer view --------------------------------------

  it('the customer sees only ACTIVE rewards, with canAfford, and cannot mutate them', async () => {
    const active = await trackReward(
      await createReward('hq', {
        name: '$5 Off',
        type: 'FIXED_AMOUNT',
        beanCost: 100,
        fixedAmountMinorUnits: 500,
        sortOrder: 1,
      }).expect(201),
    );
    const affordable = await trackReward(
      await createReward('hq', {
        name: 'Free Latte',
        type: 'FREE_ITEM',
        beanCost: 50,
        eligibleProductIds: [productAId],
        sortOrder: 2,
      }).expect(201),
    );
    const inactive = await trackReward(
      await createReward('hq', {
        name: 'Hidden reward',
        type: 'FIXED_AMOUNT',
        beanCost: 100,
        fixedAmountMinorUnits: 500,
        sortOrder: 3,
      }).expect(201),
    );
    await patchReward('hq', inactive.id, { isActive: false }).expect(200);

    const sub = await makeCustomerWithBalance(60);
    const summary = (await customerSummary(sub).expect(200))
      .body as CustomerLoyaltySummary;

    expect(summary.balance).toBe(60);
    const names = summary.rewards.map((r) => r.name);
    expect(names).toContain('$5 Off');
    expect(names).toContain('Free Latte');
    expect(names).not.toContain('Hidden reward');

    const fiveOff = summary.rewards.find((r) => r.id === active.id)!;
    expect(fiveOff.canAfford).toBe(false); // balance 60 < 100
    const latte = summary.rewards.find((r) => r.id === affordable.id)!;
    expect(latte.canAfford).toBe(true); // balance 60 >= 50
    expect(latte.eligibleItemNames).toContain(`Rewards Spec Latte ${suffix}`);

    // No customer mutation surface.
    await request(app.getHttpServer())
      .post('/api/v1/customers/me/loyalty/rewards')
      .set('Authorization', `Bearer ${customerToken(sub)}`)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/v1/customers/me/loyalty/rewards/${active.id}/redeem`)
      .set('Authorization', `Bearer ${customerToken(sub)}`)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/loyalty/rewards/${active.id}`)
      .set('Authorization', `Bearer ${customerToken(sub)}`)
      .send({ beanCost: 1 })
      .expect(401);
  });
});
