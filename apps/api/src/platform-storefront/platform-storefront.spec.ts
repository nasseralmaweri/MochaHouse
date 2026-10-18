import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  LocationSummary,
  OwnerBusinessCreateResponse,
  PlatformPermission,
  PlatformStorefrontView,
} from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  applyMigrations,
  createScratchDatabase,
  listMigrations,
  type ScratchDatabase,
} from '@mocha-house/testing';
import { AppModule } from '../app.module';
import { grantPlatformPermissions } from '../../test/platform-permissions';
import { PrismaService } from '../prisma/prisma.service';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signPlatformDevJwt } from '../platform-auth/infrastructure/platform-dev-jwt';
import { deriveDevOwnerRegistrationCode } from '../owner-registration/infrastructure/local-dev-owner-registration.provider';
import { signStorefrontContext } from '../tenancy/storefront-context';

// SC4f-3a — storefront publishing in the Platform Console, end to end on the
// real AppModule in a SCRATCH database: storefront.manage and a recent
// sign-in on every change; a reason and the business's slug; approved
// addresses only (the business's platform subdomain, or a configured
// existing address for Mocha House only); unique ownership, never moved to
// another business; the publishing checks (active, billing, a set-up
// location with a usable menu — browse-only allowed); concurrency-safe,
// append-only, audited; and publication never making anything public while
// host routing is off.
jest.setTimeout(240_000);

describe('SC4f-3a platform storefront publishing (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc4f3a-platform-${randomUUID()}`;
  const INTERNAL_SECRET = `sc4f3a-internal-${randomUUID()}`;
  const STOREFRONT_SECRET = `sc4f3a-storefront-${'x'.repeat(24)}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  const DOMAIN = 'shops.centerivo.test';
  const LEGACY_A = 'order.mochahouse.test';
  const LEGACY_B = 'www.mochahouse.test';
  const REASON = 'Approved storefront launch for this business';

  let ready: { id: string; slug: string };
  let bare: { id: string; slug: string };
  let growth: { versionId: string; month: string };

  async function operator(key: string, permissions: PlatformPermission[]) {
    const row = await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: `platform-dev:sc4f3a-${key}-${run}`,
        email: `sc4f3a-${key}-${run}@example.test`,
        status: 'ACTIVE',
      },
    });
    if (permissions.length) {
      await grantPlatformPermissions(prisma, row.id, permissions);
    }
    return row.id;
  }
  const platformToken = (key: string, signedInSecondsAgo = 0) =>
    signPlatformDevJwt(
      {
        sub: `platform-dev:sc4f3a-${key}-${run}`,
        mfa: true,
        iat: Math.floor(Date.now() / 1000) - signedInSecondsAgo,
      },
      PLATFORM_SECRET,
      3600,
    );
  const http = () => request(app.getHttpServer());
  const path = (tenantId: string, rest = '') =>
    `/api/v1/platform/tenants/${tenantId}/storefront${rest}`;
  const as = (
    key: string,
    method: 'get' | 'post',
    url: string,
    body?: object,
    signedInSecondsAgo = 0,
  ) => {
    const req = http()
      [method](url)
      .set('Authorization', `Bearer ${platformToken(key, signedInSecondsAgo)}`);
    return body ? req.send(body) : req;
  };
  const view = async (tenantId: string) =>
    (await as('manager', 'get', path(tenantId)).expect(200))
      .body as PlatformStorefrontView;
  const assignPlatform = (
    tenant: { id: string; slug: string },
    key = 'manager',
  ) =>
    as(key, 'post', path(tenant.id, '/hosts'), {
      kind: 'PLATFORM_SUBDOMAIN',
      reason: REASON,
      confirmSlug: tenant.slug,
    });
  const assignLegacy = (
    tenant: { id: string; slug: string },
    hostname: string,
  ) =>
    as('manager', 'post', path(tenant.id, '/hosts'), {
      kind: 'LEGACY',
      hostname,
      reason: REASON,
      confirmSlug: tenant.slug,
    });
  const change = (
    tenant: { id: string; slug: string },
    hostId: string,
    action: 'publish' | 'unpublish',
    overrides: {
      key?: string;
      confirmSlug?: string;
      signedInSecondsAgo?: number;
    } = {},
  ) =>
    as(
      overrides.key ?? 'manager',
      'post',
      path(tenant.id, `/hosts/${hostId}/${action}`),
      { reason: REASON, confirmSlug: overrides.confirmSlug ?? tenant.slug },
      overrides.signedInSecondsAgo ?? 0,
    );
  const hostIdOf = async (tenantId: string, hostname: string) =>
    (await view(tenantId)).hosts.find((h) => h.hostname === hostname)!.id;

  // A business with a fully set-up location and a usable menu. Digital
  // ordering is deliberately OFF: browse-only may still be published.
  async function setUpBusiness(slug: string) {
    const tenant = await prisma.tenant.create({
      data: { slug, name: `Cafe ${slug}`, status: 'ACTIVE' },
      select: { id: true, slug: true },
    });
    // Billing: an ACTIVE subscription to the founding plan (every business
    // CENTERIVO provisions has one).
    const founding = await prisma.subscriptionPlanVersion.findFirstOrThrow({
      where: { plan: { key: 'founding' }, version: 1 },
      select: { id: true },
    });
    await prisma.tenantSubscription.create({
      data: {
        subscriberTenantId: tenant.id,
        planVersionId: founding.id,
        status: 'ACTIVE',
        startedAt: new Date(),
      },
    });
    const location = await prisma.location.create({
      data: {
        tenantId: tenant.id,
        name: `Store ${slug}`,
        slug: `store-${slug}`,
        isDigitalOrderingEnabled: false,
        addressLine1: '1 Main Street',
        city: 'Dearborn',
        countryCode: 'US',
        timeZone: 'America/Detroit',
        phone: '+13135550100',
        openingHoursSetAt: new Date(),
      },
      select: { id: true },
    });
    await prisma.locationOpeningPeriod.create({
      data: {
        tenantId: tenant.id,
        locationId: location.id,
        dayOfWeek: 1,
        opensAtMinute: 420,
        closesAtMinute: 1080,
      },
    });
    const category = await prisma.category.create({
      data: { tenantId: tenant.id, name: 'Coffee', slug: `coffee-${slug}` },
      select: { id: true },
    });
    const product = await prisma.product.create({
      data: {
        tenantId: tenant.id,
        name: 'Latte',
        slug: `latte-${slug}`,
        categoryId: category.id,
        basePrice: 450,
      },
      select: { id: true },
    });
    const menu = await prisma.menu.create({
      data: { tenantId: tenant.id, name: 'Menu', slug: `menu-${slug}` },
      select: { id: true },
    });
    await prisma.menuProduct.create({
      data: { tenantId: tenant.id, menuId: menu.id, productId: product.id },
    });
    await prisma.locationMenu.create({
      data: { tenantId: tenant.id, locationId: location.id, menuId: menu.id },
    });
    return tenant;
  }

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc4f3a_storefront',
    );
    await applyMigrations(
      scratch.url,
      listMigrations(
        join(__dirname, '../../../../packages/database/prisma/migrations'),
      ),
    );
    Object.assign(process.env, {
      DATABASE_URL: scratch.url,
      PLATFORM_AUTH_PROVIDER: 'dev',
      PLATFORM_AUTH_DEV_JWT_SECRET: PLATFORM_SECRET,
      INTERNAL_AUTH_PROVIDER: 'dev',
      INTERNAL_AUTH_DEV_JWT_SECRET: INTERNAL_SECRET,
      RATE_LIMIT_ENABLED: '0',
      SAAS_BILLING_PROVIDER: 'fake',
      SAAS_BILLING_TRIAL_CLAIM_SECRET: `sc4f3a-claims-${randomUUID()}`,
      BILLING_CHECKOUT_RETURN_URL: 'http://localhost:3000/admin/billing',
      STOREFRONT_DOMAIN: DOMAIN,
      LEGACY_STOREFRONT_HOSTNAMES: `${LEGACY_A},${LEGACY_B}`,
      // Test-only trusted configuration: the business those addresses belong to.
      LEGACY_STOREFRONT_TENANT_ID: TENANT_1_MOCHA_HOUSE_ID,
      STOREFRONT_CONTEXT_SECRET: STOREFRONT_SECRET,
      // Test-only, in this scratch database: registration on so a
      // self-service business awaiting payment setup can be created.
      SELF_SERVICE_REGISTRATION_ENABLED: '1',
      SELF_SERVICE_TERMS_VERSION: 'terms-1',
      SELF_SERVICE_PRIVACY_VERSION: 'privacy-1',
      SELF_SERVICE_REGISTRATION_SECRET: `sc4f3a-registration-${randomUUID()}`,
      SELF_SERVICE_REGISTRATION_DAILY_LIMIT: '40',
    });
    // Host routing stays OFF (the deployment default).
    delete process.env.STOREFRONT_HOST_ROUTING_ENABLED;
    delete process.env.BILLING_ENFORCEMENT_ENABLED;
    delete process.env.BILLING_NOTIFICATIONS_ENABLED;

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>({
      rawBody: true,
    });
    await app.init();
    prisma = app.get(PrismaService);

    const plan = await prisma.subscriptionPlan.create({
      data: {
        key: `growth-${run}`,
        name: 'Growth',
        selfServiceAvailable: true,
        versions: {
          create: {
            version: 1,
            status: 'PUBLISHED',
            moduleKeys: ['loyalty'],
            publishedAt: new Date(),
          },
        },
        prices: {
          create: [
            { interval: 'MONTH', currency: 'USD', amountMinorUnits: 4900 },
          ],
        },
      },
      include: { versions: true, prices: true },
    });
    growth = { versionId: plan.versions[0].id, month: plan.prices[0].id };

    ready = await setUpBusiness(`ready-${run}`);
    bare = await prisma.tenant.create({
      data: { slug: `bare-${run}`, name: 'Bare Cafe', status: 'ACTIVE' },
      select: { id: true, slug: true },
    });

    await operator('none', []);
    await operator('billing', ['billing.reports.view']);
    await operator('manager', ['storefront.manage']);
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = { ...originalEnv };
      await scratch?.drop();
    }
  });

  // --- access ---------------------------------------------------------------

  it('requires storefront.manage on every route, and never admits business staff or anonymous callers', async () => {
    const routes = [
      ['get', path(ready.id)],
      ['post', path(ready.id, '/hosts')],
      ['post', path(ready.id, `/hosts/${randomUUID()}/publish`)],
      ['post', path(ready.id, `/hosts/${randomUUID()}/unpublish`)],
    ] as const;
    for (const [method, url] of routes) {
      for (const key of ['none', 'billing']) {
        await as(key, method, url, {
          reason: REASON,
          confirmSlug: ready.slug,
        }).expect(403);
      }
      await http()[method](url).expect(401);
      const staff = signInternalDevJwt(
        {
          sub: 'internal-dev:owner@example.test',
          email: 'owner@example.test',
          name: null,
          email_verified: true,
        },
        INTERNAL_SECRET,
        3600,
      );
      await http()
        [method](url)
        .set('Authorization', `Bearer ${staff}`)
        .expect(401);
    }
    expect(
      await prisma.platformAuditEvent.count({
        where: { action: 'platform.access.denied' },
      }),
    ).toBeGreaterThan(0);
  });

  it('requires a recent sign-in for every change, but not to look', async () => {
    const stale = 16 * 60;
    await as('manager', 'get', path(ready.id), undefined, stale).expect(200);
    const refused = await as(
      'manager',
      'post',
      path(ready.id, '/hosts'),
      { kind: 'PLATFORM_SUBDOMAIN', reason: REASON, confirmSlug: ready.slug },
      stale,
    ).expect(401);
    expect(refused.body).toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
    expect((await view(ready.id)).hosts).toEqual([]);
  });

  it('refuses a missing reason, a wrong slug and unknown fields', async () => {
    const bad = [
      { kind: 'PLATFORM_SUBDOMAIN', reason: 'short', confirmSlug: ready.slug },
      { kind: 'PLATFORM_SUBDOMAIN', reason: REASON, confirmSlug: bare.slug },
      {
        kind: 'PLATFORM_SUBDOMAIN',
        reason: REASON,
        confirmSlug: ready.slug,
        hostname: 'evil.example.com',
      },
      {
        kind: 'PLATFORM_SUBDOMAIN',
        reason: REASON,
        confirmSlug: ready.slug,
        tenantId: bare.id,
      },
      {
        kind: 'CUSTOM',
        hostname: 'shop.example.com',
        reason: REASON,
        confirmSlug: ready.slug,
      },
    ];
    for (const body of bad) {
      await as('manager', 'post', path(ready.id, '/hosts'), body).expect(400);
    }
    const mismatch = await as(
      'manager',
      'post',
      path(ready.id, '/hosts'),
      bad[1],
    );
    expect(mismatch.body).toMatchObject({ code: 'STOREFRONT_SLUG_MISMATCH' });
    expect((await view(ready.id)).hosts).toEqual([]);
  });

  // --- assignment -----------------------------------------------------------

  it("assigns the business's own platform address, once, unpublished, with history and audit", async () => {
    const before = await view(ready.id);
    expect(before.assignable).toMatchObject({
      platformHostname: `${ready.slug}.${DOMAIN}`,
      platformUnavailable: null,
      legacyHostnames: [],
    });
    const assigned = (await assignPlatform(ready).expect(200))
      .body as PlatformStorefrontView;
    expect(assigned.hosts).toEqual([
      expect.objectContaining({
        hostname: `${ready.slug}.${DOMAIN}`,
        kind: 'PLATFORM_SUBDOMAIN',
        published: false,
        live: false,
      }),
    ]);
    expect(assigned.assignable.platformUnavailable).toBe('already_assigned');
    expect(assigned.history).toEqual([
      expect.objectContaining({
        action: 'ASSIGNED',
        reason: REASON,
        actorEmail: `sc4f3a-manager-${run}@example.test`,
      }),
    ]);
    const again = await assignPlatform(ready).expect(409);
    expect(again.body).toMatchObject({ code: 'STOREFRONT_HOST_UNCHANGED' });
    expect(
      await prisma.platformAuditEvent.count({
        where: {
          action: 'platform.storefront.assigned',
          targetType: 'storefront_host',
          targetId: assigned.hosts[0].id,
        },
      }),
    ).toBe(1);
  });

  it('registers approved existing addresses for Mocha House only, never twice, and never from another business', async () => {
    const mocha = { id: TENANT_1_MOCHA_HOUSE_ID, slug: 'mocha-house' };
    const tenant1 = await prisma.tenant.findUniqueOrThrow({
      where: { id: TENANT_1_MOCHA_HOUSE_ID },
      select: { slug: true },
    });
    mocha.slug = tenant1.slug;

    expect((await view(mocha.id)).assignable.legacyHostnames).toEqual(
      [LEGACY_A, LEGACY_B].sort(),
    );
    // Another business can never claim a Mocha House address.
    const stolen = await assignLegacy(ready, LEGACY_A).expect(409);
    expect(stolen.body).toMatchObject({
      code: 'STOREFRONT_ASSIGNMENT_UNAVAILABLE',
    });
    // Only configured addresses — never an arbitrary one.
    await assignLegacy(mocha, 'anything.mochahouse.test').expect(409);

    await assignLegacy(mocha, LEGACY_A.toUpperCase()).expect(200);
    const twice = await assignLegacy(mocha, LEGACY_A).expect(409);
    expect(twice.body).toMatchObject({ code: 'STOREFRONT_HOST_TAKEN' });
    const after = await view(mocha.id);
    expect(after.hosts.map((h) => [h.hostname, h.kind])).toEqual([
      [LEGACY_A, 'LEGACY'],
    ]);
    expect(after.assignable.legacyHostnames).not.toContain(LEGACY_A);
    // Nothing of Mocha House's shows on another business's page.
    expect(JSON.stringify(await view(ready.id))).not.toContain(LEGACY_A);
  });

  it('never moves an address to another business (database guard)', async () => {
    const hostId = await hostIdOf(ready.id, `${ready.slug}.${DOMAIN}`);
    await expect(
      prisma.storefrontHost.update({
        where: { id: hostId },
        data: { storefrontTenantId: bare.id },
      }),
    ).rejects.toThrow();
  });

  // --- publishing -----------------------------------------------------------

  it("refuses to publish another business's address, exactly like a missing one", async () => {
    const hostId = await hostIdOf(ready.id, `${ready.slug}.${DOMAIN}`);
    const foreign = await change(bare, hostId, 'publish').expect(404);
    const missing = await change(bare, randomUUID(), 'publish').expect(404);
    expect(foreign.body).toEqual(missing.body);
    // Even with the owning business's slug.
    await change(bare, hostId, 'publish', { confirmSlug: ready.slug }).expect(
      400,
    );
    expect((await view(ready.id)).hosts[0].published).toBe(false);
  });

  it('publishes a browse-only business that meets the checks — and it is still not live while host routing is off', async () => {
    const before = await view(ready.id);
    expect(before.eligibility).toEqual({
      eligible: true,
      checks: [
        { key: 'business_active', passed: true },
        { key: 'billing_authorized', passed: true },
        { key: 'location_configured', passed: true },
        { key: 'menu_available', passed: true },
      ],
    });
    const hostId = before.hosts[0].id;
    const published = (await change(ready, hostId, 'publish').expect(200))
      .body as PlatformStorefrontView;
    expect(published.hostRouting).toBe(false);
    expect(published.hosts[0]).toMatchObject({ published: true, live: false });
    expect(published.history[0]).toMatchObject({ action: 'PUBLISHED' });

    // With routing off the deployment still serves its single business: a
    // signed context for the published address changes nothing.
    const seconds = Math.floor(Date.now() / 1000);
    const hostname = `${ready.slug}.${DOMAIN}`;
    const locations = await http()
      .get('/api/v1/locations')
      .set({
        'x-centerivo-storefront-host': hostname,
        'x-centerivo-storefront-ts': String(seconds),
        'x-centerivo-storefront-sig': signStorefrontContext(
          STOREFRONT_SECRET,
          hostname,
          seconds,
        ),
      })
      .expect(200);
    const seen = (locations.body as LocationSummary[]).map((l) => l.name);
    expect(seen).not.toContain(`Store ${ready.slug}`);

    const again = await change(ready, hostId, 'publish').expect(409);
    expect(again.body).toMatchObject({ code: 'STOREFRONT_HOST_UNCHANGED' });
  });

  it('refuses to publish a business that is not set up or has no subscription, and says what is missing', async () => {
    await assignPlatform(bare).expect(200);
    const hostId = await hostIdOf(bare.id, `${bare.slug}.${DOMAIN}`);
    const refused = await change(bare, hostId, 'publish').expect(409);
    expect(refused.body).toMatchObject({
      code: 'STOREFRONT_NOT_ELIGIBLE',
      // No subscription: billing fails closed.
      missing: ['billing_authorized', 'location_configured', 'menu_available'],
    });
    expect((await view(bare.id)).hosts[0].published).toBe(false);
  });

  it('refuses to publish a self-service business whose billing is not yet authorized', async () => {
    const email = `sc4f3a-owner-${run}@example.com`;
    const code = deriveDevOwnerRegistrationCode(
      email,
      'sign-up',
      INTERNAL_SECRET,
    );
    await http()
      .post('/api/v1/internal/registration/start')
      .send({ email })
      .expect(202);
    await http()
      .post('/api/v1/internal/registration/complete')
      .send({
        email,
        code,
        password: 'Correct-Horse-9-Battery',
        displayName: 'Owner',
        termsVersion: 'terms-1',
        privacyVersion: 'privacy-1',
        acceptLegal: true,
      })
      .expect(200);
    const staff = signInternalDevJwt(
      { sub: `internal-dev:${email}`, email, name: null, email_verified: true },
      INTERNAL_SECRET,
      3600,
    );
    const created = await http()
      .post('/api/v1/internal/onboarding/business')
      .set('Authorization', `Bearer ${staff}`)
      .send({
        businessName: `Owner Cafe ${run}`,
        planVersionId: growth.versionId,
        planPriceId: growth.month,
        expectedPrice: {
          interval: 'MONTH',
          currency: 'USD',
          amountMinorUnits: 4900,
        },
      })
      .expect(201);
    const owned = (created.body as OwnerBusinessCreateResponse).business;
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: owned.id },
      select: { id: true, slug: true },
    });
    const checks = (await view(tenant.id)).eligibility.checks;
    expect(checks.find((c) => c.key === 'billing_authorized')).toEqual({
      key: 'billing_authorized',
      passed: false,
    });
  });

  it('refuses to publish a suspended business; unpublishing is always allowed and nothing unpublishes automatically', async () => {
    const hostId = (await view(ready.id)).hosts[0].id;
    await prisma.tenant.update({
      where: { id: ready.id },
      data: { status: 'SUSPENDED', suspensionReason: 'SECURITY' },
    });
    try {
      const whileSuspended = await view(ready.id);
      expect(whileSuspended.eligibility.eligible).toBe(false);
      // Still published: never unpublished automatically.
      expect(whileSuspended.hosts[0].published).toBe(true);
      await change(ready, hostId, 'unpublish').expect(200);
      const refused = await change(ready, hostId, 'publish').expect(409);
      expect(refused.body).toMatchObject({
        code: 'STOREFRONT_NOT_ELIGIBLE',
        missing: ['business_active'],
      });
    } finally {
      await prisma.tenant.update({
        where: { id: ready.id },
        data: { status: 'ACTIVE', suspensionReason: null },
      });
    }
  });

  it('a suspension that commits during a publish is seen by its checks (never published while suspended)', async () => {
    const hostId = (await view(ready.id)).hosts[0].id;
    expect((await view(ready.id)).hosts[0].published).toBe(false);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    // A suspension in progress: its row lock is held until it commits.
    const suspension = prisma.$transaction(
      async (tx) => {
        await tx.tenant.update({
          where: { id: ready.id },
          data: { status: 'SUSPENDED', suspensionReason: 'SECURITY' },
        });
        locked();
        await held;
      },
      { timeout: 30_000 },
    );
    await lockTaken;
    const publishing = change(ready, hostId, 'publish').then((res) => res);
    // Give the publish time to reach (and wait on) the business row.
    await new Promise((resolve) => setTimeout(resolve, 500));
    release();
    await suspension;
    try {
      const res = await publishing;
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({
        code: 'STOREFRONT_NOT_ELIGIBLE',
        missing: ['business_active'],
      });
      expect((await view(ready.id)).hosts[0].published).toBe(false);
    } finally {
      await prisma.tenant.update({
        where: { id: ready.id },
        data: { status: 'ACTIVE', suspensionReason: null },
      });
    }
  });

  it('applies concurrent publishes of one address exactly once', async () => {
    const hostId = (await view(ready.id)).hosts[0].id;
    expect((await view(ready.id)).hosts[0].published).toBe(false);
    const before = await prisma.storefrontHostChange.count({
      where: { storefrontHostId: hostId, action: 'PUBLISHED' },
    });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => change(ready, hostId, 'publish')),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    expect(
      await prisma.storefrontHostChange.count({
        where: { storefrontHostId: hostId, action: 'PUBLISHED' },
      }),
    ).toBe(before + 1);
  });

  // --- history --------------------------------------------------------------

  it('keeps the history append-only and per business', async () => {
    const row = await prisma.storefrontHostChange.findFirstOrThrow({
      select: { id: true },
    });
    await expect(
      prisma.storefrontHostChange.update({
        where: { id: row.id },
        data: { reason: 'Rewritten history entry' },
      }),
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.storefrontHostChange.delete({ where: { id: row.id } }),
    ).rejects.toThrow(/append-only/);

    const readyHistory = (await view(ready.id)).history;
    const bareHistory = (await view(bare.id)).history;
    expect(readyHistory.every((h) => h.hostname.startsWith(ready.slug))).toBe(
      true,
    );
    expect(bareHistory.every((h) => h.hostname.startsWith(bare.slug))).toBe(
      true,
    );
    expect(readyHistory.map((h) => h.action)).toEqual([
      'PUBLISHED',
      'UNPUBLISHED',
      'PUBLISHED',
      'ASSIGNED',
    ]);
  });
});
