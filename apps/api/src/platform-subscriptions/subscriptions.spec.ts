import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  INTERNAL_PERMISSION_KEYS,
  OPTIONAL_MODULE_KEYS,
  type InternalMeResponse,
  type PlatformPlan,
  type PlatformPlanListResponse,
  type PlatformSubscriptionChangeResponse,
  type PlatformSubscriptionPreviewResponse,
  type PlatformTenantSubscriptionResponse,
} from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  applyMigrationSql,
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  withScratchClient,
  type ScratchDatabase,
} from '@mocha-house/testing';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { signPlatformDevJwt } from '../platform-auth/infrastructure/platform-dev-jwt';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';

// SC2a — plans, subscriptions, add-ons and admin entitlement enforcement,
// end to end on the real AppModule in a SCRATCH database (subscription
// history is append-only, so it never touches the shared test database):
//   - the Founding migration keeps every existing business (Mocha House
//     included) on every module, idempotently, never overwriting;
//   - a business with NO subscription has core only (fail closed);
//   - the admin API enforces the plan (403 MODULE_NOT_ENTITLED), /me reports
//     it, lifecycle-retained permissions stay usable, data is never deleted;
//   - plans: draft -> publish (immutable, also in the database) -> retire;
//   - subscriptions: preview, assign/change (published only), add-ons;
//   - provisioning requires a published plan;
//   - operators only, recent sign-in for changes, audited.
const MIGRATIONS = join(
  __dirname,
  '../../../../packages/database/prisma/migrations',
);
const FOUNDING_VERSION = '01a0db02-f800-7000-8000-00000000f002';

describe('SC2a plans, subscriptions and entitlements (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc2a-platform-${randomUUID()}`;
  const INTERNAL_SECRET = `sc2a-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  const BIZ = randomUUID();

  const operatorToken = (key = 'active', iat?: number) =>
    signPlatformDevJwt(
      {
        sub: `platform-dev:sc2a-${key}-${run}`,
        mfa: true,
        ...(iat ? { iat } : {}),
      },
      PLATFORM_SECRET,
      3600,
    );
  const staffToken = (key: string) =>
    signInternalDevJwt(
      {
        sub: `internal-dev:sc2a-${key}-${run}`,
        email: `sc2a-${key}-${run}@example.com`,
        name: null,
        email_verified: true,
      },
      INTERNAL_SECRET,
      3600,
    );
  const platform = (
    method: 'get' | 'post' | 'put' | 'delete',
    path: string,
    body?: object,
    token: string | null = operatorToken(),
  ) => {
    let req = request(app.getHttpServer())[method](`/api/v1/platform${path}`);
    if (token) req = req.set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };
  const admin = (key: string, tenantId: string, path: string) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .set('Authorization', `Bearer ${staffToken(key)}`)
      .set('X-Tenant-Id', tenantId);
  const me = async (key: string, tenantId: string) =>
    (await admin(key, tenantId, '/internal/me').expect(200))
      .body as InternalMeResponse;
  const subscription = async (tenantId: string) =>
    (await platform('get', `/tenants/${tenantId}/subscription`).expect(200))
      .body as PlatformTenantSubscriptionResponse;

  // A staff member holding EVERY permission at corporate scope.
  async function administrator(key: string, tenantId: string) {
    const role = await prisma.internalRole.create({
      data: {
        tenantId,
        key: `sc2a-all-${key}-${run}`,
        displayName: 'All permissions',
        permissions: {
          create: INTERNAL_PERMISSION_KEYS.map((permissionKey) => ({
            permissionKey,
          })),
        },
      },
    });
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:sc2a-${key}-${run}`,
        email: `sc2a-${key}-${run}@example.com`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId,
        internalUserId: user.id,
        roleId: role.id,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc2a_subscriptions',
    );
    await applyMigrations(scratch.url, listMigrations(MIGRATIONS));
    process.env.DATABASE_URL = scratch.url;
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = INTERNAL_SECRET;
    process.env.RATE_LIMIT_ENABLED = '0';
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);

    for (const [key, status] of [
      ['active', 'ACTIVE'],
      ['disabled', 'DISABLED'],
    ] as const) {
      await prisma.platformOperator.create({
        data: {
          externalProvider: 'platform-dev',
          externalSubject: `platform-dev:sc2a-${key}-${run}`,
          email: `sc2a-${key}-${run}@example.test`,
          status,
        },
      });
    }
    // A business created AFTER plans existed, with no subscription.
    await prisma.tenant.create({
      data: {
        id: BIZ,
        slug: `sc2a-biz-${run}`,
        name: 'SC2a Business',
        status: 'ACTIVE',
      },
    });
    await administrator('biz', BIZ);
    await administrator('mocha', TENANT_1_MOCHA_HOUSE_ID);
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = { ...originalEnv };
      await scratch?.drop();
    }
  });

  // --- Founding plan --------------------------------------------------------

  it('Mocha House (an existing business) is on the published Founding plan with every module, and keeps full access', async () => {
    const sub = await subscription(TENANT_1_MOCHA_HOUSE_ID);
    expect(sub.subscription).toMatchObject({
      plan: { key: 'founding', name: 'Founding' },
      version: { id: FOUNDING_VERSION, version: 1, status: 'PUBLISHED' },
      addOns: [],
    });
    expect(sub.modules).toEqual(['core', ...[...OPTIONAL_MODULE_KEYS].sort()]);
    expect(sub.history.map((h) => h.type)).toEqual(['PLAN_ASSIGNED']);

    const mocha = await me('mocha', TENANT_1_MOCHA_HOUSE_ID);
    expect([...mocha.authorization.permissions].sort()).toEqual(
      [...INTERNAL_PERMISSION_KEYS].sort(),
    );
    expect(mocha.entitlements.planName).toBe('Founding');
    await admin('mocha', TENANT_1_MOCHA_HOUSE_ID, '/admin/customers').expect(
      200,
    );
    await admin('mocha', TENANT_1_MOCHA_HOUSE_ID, '/admin/careers/jobs').expect(
      200,
    );
  });

  it('the Founding backfill is idempotent and never overwrites an existing subscription', async () => {
    const backfill = readFileSync(
      join(
        MIGRATIONS,
        '20261024090000_subscription_plans_foundation/migration.sql',
      ),
      'utf8',
    )
      .split('-- Founding plan backfill')[1]
      // Drop the rest of the marker comment line.
      .replace(/^[^\n]*\n/, '');
    const before = await prisma.tenantSubscription.findMany({
      orderBy: { id: 'asc' },
    });
    const events = await prisma.tenantSubscriptionEvent.count();
    await applyMigrationSql(scratch.url, backfill);
    // BIZ (created after the migration) is now picked up; nobody else changes.
    const after = await prisma.tenantSubscription.findMany({
      orderBy: { id: 'asc' },
    });
    for (const row of before) {
      expect(after.find((a) => a.id === row.id)).toEqual(row);
    }
    expect(
      after
        .filter((a) => !before.some((b) => b.id === a.id))
        .map((a) => a.subscriberTenantId),
    ).toEqual([BIZ]);
    expect(await prisma.tenantSubscriptionEvent.count()).toBe(events + 1);
    // Back to "no subscription" for the core-only tests below.
    await withScratchClient(scratch.url, async (c) => {
      await c.query(
        `ALTER TABLE "TenantSubscriptionEvent" DISABLE TRIGGER "TenantSubscriptionEvent_append_only"`,
      );
      await c.query(
        `DELETE FROM "TenantSubscriptionEvent" e USING "TenantSubscription" s WHERE e."subscriptionId" = s.id AND s."subscriberTenantId" = $1`,
        [BIZ],
      );
      await c.query(
        `ALTER TABLE "TenantSubscriptionEvent" ENABLE TRIGGER "TenantSubscriptionEvent_append_only"`,
      );
      await c.query(
        `DELETE FROM "TenantSubscription" WHERE "subscriberTenantId" = $1`,
        [BIZ],
      );
    });
    expect((await subscription(BIZ)).subscription).toBeNull();
  });

  // --- enforcement ----------------------------------------------------------

  it('a business with NO subscription has core only — the admin API refuses other modules with MODULE_NOT_ENTITLED, retained permissions excepted', async () => {
    const view = await me('biz', BIZ);
    expect(view.entitlements).toEqual({
      modules: ['core'],
      planName: null,
      paymentSetupPending: false,
    });
    expect(view.authorization.permissions).not.toContain('customers.view');
    expect(view.authorization.permissions).toEqual(
      expect.arrayContaining([
        'users.view',
        'giftcards.view',
        'loyalty.adjust',
      ]),
    );

    await admin('biz', BIZ, '/admin/internal-users').expect(200);
    const blocked = await admin('biz', BIZ, '/admin/customers').expect(403);
    expect(blocked.body).toMatchObject({ code: 'MODULE_NOT_ENTITLED' });
    await admin('biz', BIZ, '/admin/careers/jobs').expect(403);
    await admin('biz', BIZ, '/admin/gift-cards/configuration').expect(403);
    // Lifecycle-retained: reaching stored gift-card value is never blocked.
    await admin('biz', BIZ, `/admin/gift-cards/${randomUUID()}`).expect(404);
  });

  // --- plans ----------------------------------------------------------------

  let starter: PlatformPlan;

  it('creates a plan (draft), edits the draft, publishes it — then it is immutable, in the API and in the database', async () => {
    starter = (
      await platform('post', '/plans', {
        key: `starter-${run}`,
        name: 'Starter',
        moduleKeys: ['careers', 'loyalty', 'careers'],
      }).expect(201)
    ).body as PlatformPlan;
    const draft = starter.versions[0];
    expect(draft).toMatchObject({
      version: 1,
      status: 'DRAFT',
      moduleKeys: ['loyalty', 'careers'],
    });

    await platform('put', `/plans/${starter.id}/versions/${draft.id}`, {
      moduleKeys: ['crm'],
    }).expect(200);
    const published = (
      await platform(
        'post',
        `/plans/${starter.id}/versions/${draft.id}/publish`,
      ).expect(200)
    ).body as PlatformPlan;
    expect(published.versions[0]).toMatchObject({
      status: 'PUBLISHED',
      moduleKeys: ['crm'],
    });

    const edit = await platform(
      'put',
      `/plans/${starter.id}/versions/${draft.id}`,
      { moduleKeys: ['cms'] },
    ).expect(409);
    expect(edit.body).toMatchObject({ code: 'PLAN_VERSION_NOT_DRAFT' });
    await expect(
      prisma.subscriptionPlanVersion.update({
        where: { id: draft.id },
        data: { moduleKeys: ['cms'] },
      }),
    ).rejects.toThrow(/immutable/);
    await expect(
      prisma.subscriptionPlanVersion.delete({ where: { id: draft.id } }),
    ).rejects.toThrow(/cannot be deleted/);

    const dup = await platform('post', '/plans', {
      key: `starter-${run}`,
      name: 'Again',
      moduleKeys: [],
    }).expect(409);
    expect(dup.body).toMatchObject({ code: 'PLAN_KEY_TAKEN' });
    for (const body of [
      { key: 'Bad Key', name: 'x y', moduleKeys: [] },
      { key: 'ok-key', name: 'Fine', moduleKeys: ['payments'] },
      {},
    ]) {
      await platform('post', '/plans', body).expect(400);
    }
  });

  it('previews a change without making it, then assigns the published version and the admin API follows', async () => {
    const version = starter.versions[0].id;
    const preview = (
      await platform('post', `/tenants/${BIZ}/subscription/preview`, {
        planVersionId: version,
      }).expect(200)
    ).body as PlatformSubscriptionPreviewResponse;
    expect(preview).toEqual({
      current: ['core'],
      proposed: ['core', 'crm'],
      gained: ['crm'],
      lost: [],
    });
    expect((await subscription(BIZ)).subscription).toBeNull();

    const changed = (
      await platform('put', `/tenants/${BIZ}/subscription`, {
        planVersionId: version,
      }).expect(200)
    ).body as PlatformSubscriptionChangeResponse;
    expect(changed).toMatchObject({
      changed: true,
      modules: ['core', 'crm'],
      subscription: { plan: { name: 'Starter' } },
    });
    await admin('biz', BIZ, '/admin/customers').expect(200);
    await admin('biz', BIZ, '/admin/careers/jobs').expect(403);
    // Again: nothing changes.
    expect(
      (
        (
          await platform('put', `/tenants/${BIZ}/subscription`, {
            planVersionId: version,
          }).expect(200)
        ).body as PlatformSubscriptionChangeResponse
      ).changed,
    ).toBe(false);
  });

  it('add-ons: grant (previewed), refuse one already in the plan, revoke — data is never deleted', async () => {
    const preview = (
      await platform('post', `/tenants/${BIZ}/subscription/preview`, {
        grant: 'careers',
      }).expect(200)
    ).body as PlatformSubscriptionPreviewResponse;
    expect(preview.gained).toEqual(['careers']);
    await platform('post', `/tenants/${BIZ}/subscription/add-ons`, {
      moduleKey: 'careers',
    }).expect(200);
    await admin('biz', BIZ, '/admin/careers/jobs').expect(200);
    const inPlan = await platform(
      'post',
      `/tenants/${BIZ}/subscription/add-ons`,
      { moduleKey: 'crm' },
    ).expect(409);
    expect(inPlan.body).toMatchObject({ code: 'ADDON_IN_PLAN' });

    const job = await prisma.jobOpening.count({ where: { tenantId: BIZ } });
    const revoked = (
      await platform(
        'delete',
        `/tenants/${BIZ}/subscription/add-ons/careers`,
      ).expect(200)
    ).body as PlatformSubscriptionChangeResponse;
    expect(revoked).toMatchObject({ changed: true, modules: ['core', 'crm'] });
    await admin('biz', BIZ, '/admin/careers/jobs').expect(403);
    expect(await prisma.jobOpening.count({ where: { tenantId: BIZ } })).toBe(
      job,
    );
    expect(
      (
        (
          await platform(
            'delete',
            `/tenants/${BIZ}/subscription/add-ons/careers`,
          ).expect(200)
        ).body as PlatformSubscriptionChangeResponse
      ).changed,
    ).toBe(false);

    const history = (await subscription(BIZ)).history.map((h) => [
      h.type,
      h.moduleKey,
    ]);
    expect(history).toEqual([
      ['ADDON_REVOKED', 'careers'],
      ['ADDON_GRANTED', 'careers'],
      ['PLAN_ASSIGNED', null],
    ]);
  });

  it('only a PUBLISHED version is assignable: a draft and a retired version are refused', async () => {
    const next = (
      await platform('post', `/plans/${starter.id}/versions`, {
        moduleKeys: ['crm', 'cms'],
      }).expect(201)
    ).body as PlatformPlan;
    const draft = next.versions[0];
    expect(draft).toMatchObject({ version: 2, status: 'DRAFT' });
    const again = await platform('post', `/plans/${starter.id}/versions`, {
      moduleKeys: [],
    }).expect(409);
    expect(again.body).toMatchObject({ code: 'PLAN_DRAFT_EXISTS' });
    const draftAssign = await platform('put', `/tenants/${BIZ}/subscription`, {
      planVersionId: draft.id,
    }).expect(409);
    expect(draftAssign.body).toMatchObject({
      code: 'PLAN_VERSION_NOT_PUBLISHED',
    });

    await platform(
      'post',
      `/plans/${starter.id}/versions/${draft.id}/publish`,
    ).expect(200);
    await platform(
      'post',
      `/plans/${starter.id}/versions/${starter.versions[0].id}/retire`,
    ).expect(200);
    const retired = await platform('put', `/tenants/${BIZ}/subscription`, {
      planVersionId: starter.versions[0].id,
    }).expect(409);
    expect(retired.body).toMatchObject({ code: 'PLAN_VERSION_NOT_PUBLISHED' });
    // A business already on the retired version keeps it.
    expect((await subscription(BIZ)).subscription?.version).toMatchObject({
      version: 1,
      status: 'RETIRED',
    });
    await admin('biz', BIZ, '/admin/customers').expect(200);

    const list = (await platform('get', '/plans').expect(200))
      .body as PlatformPlanListResponse;
    expect(list.plans.map((p) => p.key)).toEqual(
      expect.arrayContaining(['founding', `starter-${run}`]),
    );
    expect(list.subscriptions.total).toBe(
      await prisma.tenantSubscription.count(),
    );
  });

  it('a downgrade applies to new operations immediately; retained permissions keep stored value reachable', async () => {
    await platform('put', `/tenants/${BIZ}/subscription`, {
      planVersionId: FOUNDING_VERSION,
    }).expect(200);
    await admin('biz', BIZ, '/admin/gift-cards/configuration').expect(200);
    const newer = (await platform('get', '/plans').expect(200))
      .body as PlatformPlanListResponse;
    const v2 = newer.plans
      .find((p) => p.id === starter.id)!
      .versions.find((v) => v.version === 2)!;
    const preview = (
      await platform('post', `/tenants/${BIZ}/subscription/preview`, {
        planVersionId: v2.id,
      }).expect(200)
    ).body as PlatformSubscriptionPreviewResponse;
    expect(preview.lost).toEqual(
      expect.arrayContaining(['giftcards', 'loyalty', 'careers']),
    );
    await platform('put', `/tenants/${BIZ}/subscription`, {
      planVersionId: v2.id,
    }).expect(200);
    await admin('biz', BIZ, '/admin/gift-cards/configuration').expect(403);
    await admin('biz', BIZ, `/admin/gift-cards/${randomUUID()}`).expect(404);
    // Issuing a NEW gift card creates value: refused without the module,
    // even though giftcards.manage is retained for corrections.
    const issue = await request(app.getHttpServer())
      .post('/api/v1/admin/gift-cards')
      .set('Authorization', `Bearer ${staffToken('biz')}`)
      .set('X-Tenant-Id', BIZ)
      .send({ originalValueMinorUnits: 1000, currency: 'USD' })
      .expect(403);
    expect(issue.body).toMatchObject({ code: 'MODULE_NOT_ENTITLED' });
    expect(await prisma.giftCard.count({ where: { tenantId: BIZ } })).toBe(0);
  });

  // --- provisioning ---------------------------------------------------------

  it('provisioning requires a published plan and subscribes the new business to it', async () => {
    const body = (planVersionId: unknown) => ({
      name: 'SC2a Provisioned',
      slug: `sc2a-prov-${run}`,
      ownerEmail: `owner-${run}@example.com`,
      planVersionId,
    });
    const post = (b: object) =>
      request(app.getHttpServer())
        .post('/api/v1/platform/tenants')
        .set('Authorization', `Bearer ${operatorToken()}`)
        .set('Idempotency-Key', randomUUID())
        .send(b);
    await post({ ...body(undefined) }).expect(400);
    const draftPlan = (
      await platform('post', '/plans', {
        key: `draft-${run}`,
        name: 'Draft only',
        moduleKeys: [],
      }).expect(201)
    ).body as PlatformPlan;
    const refused = await post(body(draftPlan.versions[0].id)).expect(409);
    expect(refused.body).toMatchObject({ code: 'PLAN_VERSION_NOT_PUBLISHED' });
    expect(
      await prisma.tenant.count({ where: { slug: `sc2a-prov-${run}` } }),
    ).toBe(0);

    const created = await post(body(starter.versions[0].id)).expect(409);
    expect(created.body).toMatchObject({ code: 'PLAN_VERSION_NOT_PUBLISHED' }); // retired above
    const ok = await post(body(FOUNDING_VERSION)).expect(201);
    const tenantId = (ok.body as { tenant: { id: string } }).tenant.id;
    const sub = await subscription(tenantId);
    expect(sub.subscription?.plan.key).toBe('founding');
    expect(sub.history.map((h) => h.type)).toEqual(['PLAN_ASSIGNED']);
  });

  // --- access and audit -----------------------------------------------------

  it('operators only; every change needs a recent sign-in; reads and previews do not', async () => {
    const stale = operatorToken(
      'active',
      Math.floor(Date.now() / 1000) - 20 * 60,
    );
    for (const [method, path, body] of [
      ['post', '/plans', { key: `x-${run}`, name: 'Xx', moduleKeys: [] }],
      [
        'put',
        `/tenants/${BIZ}/subscription`,
        { planVersionId: FOUNDING_VERSION },
      ],
      ['post', `/tenants/${BIZ}/subscription/add-ons`, { moduleKey: 'cms' }],
      ['delete', `/tenants/${BIZ}/subscription/add-ons/cms`, undefined],
    ] as const) {
      const res = await platform(method, path, body, stale).expect(401);
      expect(res.body).toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
    }
    await platform('get', '/plans', undefined, stale).expect(200);
    await platform(
      'post',
      `/tenants/${BIZ}/subscription/preview`,
      { grant: 'cms' },
      stale,
    ).expect(200);
    await platform('get', '/plans', undefined, null).expect(401);
    await platform('get', '/plans', undefined, staffToken('biz')).expect(401);
    await platform(
      'get',
      `/tenants/${BIZ}/subscription`,
      undefined,
      operatorToken('disabled'),
    ).expect(403);
  });

  it('every change is in the platform audit trail', async () => {
    const actions = (
      await prisma.platformAuditEvent.findMany({ select: { action: true } })
    ).map((e) => e.action);
    for (const action of [
      'platform.plan.created',
      'platform.plan.version_updated',
      'platform.plan.version_published',
      'platform.plan.version_created',
      'platform.plan.version_retired',
      'platform.tenant.subscription_changed',
      'platform.tenant.addon_granted',
      'platform.tenant.addon_revoked',
      'platform.tenant.provisioned',
    ]) {
      expect(actions).toContain(action);
    }
  });
});
