import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  INTERNAL_PERMISSION_KEYS,
  type AdminCmsPageDetail,
  type AdminPlatformStatus,
} from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  TEST_TENANT_B_NAME,
  createTestTenantB,
  removeTestTenantB,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { resolveBusinessDate } from '../operations/application/business-date';
import { RedisModule } from '../redis/redis.module';
import { TenancyModule } from './tenancy.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import {
  signInternalDevJwt,
  type InternalDevJwtClaims,
} from '../internal-auth/infrastructure/internal-dev-jwt';
import { AdminPlatformModule } from '../admin-platform/admin-platform.module';
import { FranchisingModule } from '../franchising/franchising.module';
import { FranchisingPublicThrottleGuard } from '../franchising/infrastructure/franchising-public-throttle.guard';
import { CmsModule } from '../cms/cms.module';
import { ReportsModule } from '../reports/reports.module';
import {
  CMS_PAGE_REGISTRY,
  defaultContentFor,
} from '../cms/registry/cms-page-registry';

// Security 4A — staff identity binding, platform status scope and business
// branding, with two businesses sharing one database:
//   Tenant A = Tenant #1 (Mocha House) — its wording must be unchanged
//   Tenant B = the test-only isolation tenant
// Two app instances serve the storefront of each business (SINGLE_TENANT_ID);
// Admin routes always take the business from the validated X-Tenant-Id.
describe('Security 4A: identity, platform data and branding (integration)', () => {
  let appA: INestApplication<App>;
  let appB: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'security-4a-spec-secret';
  const suffix = randomUUID().slice(0, 8);

  const TENANT_A = TENANT_1_MOCHA_HOUSE_ID;
  const TENANT_B = TEST_TENANT_B_ID;
  const userIdsA: string[] = [];
  const roleIdsA: string[] = [];
  const locationIdsA: string[] = [];

  const subjectOf = (key: string) => `internal-dev:s4a-${key}-${suffix}`;
  const tokenFor = (claims: InternalDevJwtClaims) =>
    signInternalDevJwt(claims, internalSecret, 3600);
  const token = (key: string) =>
    tokenFor({
      sub: subjectOf(key),
      email: `s4a-${key}-${suffix}@example.test`,
      name: null,
    });

  async function role(tenantId: string, permissions: readonly string[]) {
    const created = await prisma.internalRole.create({
      data: {
        tenantId,
        key: `s4a-${randomUUID()}`,
        displayName: 'Security 4A spec role',
        permissions: {
          create: permissions.map((permissionKey) => ({
            permissionKey,
            tenantId,
          })),
        },
      },
    });
    if (tenantId === TENANT_A) roleIdsA.push(created.id);
    return created.id;
  }

  async function member(
    key: string,
    tenantId: string,
    permissions: readonly string[],
    identity: { externalSubject: string | null; email?: string } = {
      externalSubject: subjectOf(key),
    },
  ): Promise<string> {
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: identity.externalSubject,
        email: identity.email ?? `s4a-${key}-${suffix}@example.test`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    if (tenantId === TENANT_A) userIdsA.push(user.id);
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId,
        internalUserId: user.id,
        roleId: await role(tenantId, permissions),
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });
    return user.id;
  }

  async function buildApp(storefrontTenantId: string) {
    process.env.SINGLE_TENANT_ID = storefrontTenantId;
    const moduleFixture = await Test.createTestingModule({
      imports: [
        PrismaModule,
        RedisModule,
        TenancyModule,
        CustomerAuthModule,
        InternalAuthModule,
        AdminPlatformModule,
        FranchisingModule,
        CmsModule,
        ReportsModule,
      ],
    })
      .overrideGuard(FranchisingPublicThrottleGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = moduleFixture.createNestApplication<INestApplication<App>>();
    await app.init();
    return app;
  }

  const adminGet = (tok: string, tenantId: string, path: string) =>
    request(appA.getHttpServer())
      .get(`/api/v1/admin${path}`)
      .set('Authorization', `Bearer ${tok}`)
      .set('X-Tenant-Id', tenantId);
  const businesses = (tok: string) =>
    request(appA.getHttpServer())
      .get('/api/v1/internal/businesses')
      .set('Authorization', `Bearer ${tok}`);
  const bodyOf = <T>(res: { body: unknown }): T => res.body as T;
  // Reports bucket by the BUSINESS day (America/Detroit), not the UTC
  // calendar day: near midnight UTC the two differ, and a "today" range in
  // UTC would miss rows created just now.
  const today = resolveBusinessDate(new Date());
  const range = `?startDate=${today}&endDate=${today}`;

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    appA = await buildApp(TENANT_A);
    prisma = appA.get(PrismaService);
    await createTestTenantB(prisma);
    appB = await buildApp(TENANT_B);

    const all = INTERNAL_PERMISSION_KEYS;
    await member('a-admin', TENANT_A, all);
    await member('b-admin', TENANT_B, all);
    // One person in both businesses: platform.view only in A.
    await member('multi', TENANT_A, ['platform.view']);
    await member('multi', TENANT_B, ['cms.view']);
  });

  afterAll(async () => {
    try {
      await prisma.internalAuditEvent.deleteMany({
        where: { actorInternalUserId: { in: userIdsA } },
      });
      await prisma.location.deleteMany({ where: { id: { in: locationIdsA } } });
      await prisma.internalUserRoleAssignment.deleteMany({
        where: { internalUserId: { in: userIdsA } },
      });
      await prisma.internalRolePermission.deleteMany({
        where: { roleId: { in: roleIdsA } },
      });
      await prisma.internalRole.deleteMany({ where: { id: { in: roleIdsA } } });
      await prisma.internalUser.deleteMany({ where: { id: { in: userIdsA } } });
      const ownedByB = { where: { tenantId: TENANT_B } };
      for (const model of [
        prisma.internalAuditEvent,
        prisma.cmsPage,
        prisma.franchiseInquiry,
        prisma.location,
        prisma.internalUserRoleAssignment,
        prisma.internalRolePermission,
        prisma.internalRole,
        prisma.internalUser,
      ] as unknown as Array<{ deleteMany(args: object): Promise<unknown> }>) {
        await model.deleteMany(ownedByB);
      }
      await removeTestTenantB(prisma);
    } finally {
      await appB?.close();
      await appA?.close();
      process.env = { ...originalEnv };
    }
  });

  // --- (1) staff identity ------------------------------------------------

  it('(1) an unverified email claim can neither see nor bind an unbound staff record', async () => {
    const email = `s4a-invitee-${suffix}@example.test`;
    // An unbound, ACTIVE staff record in Tenant B (no login bound yet).
    const rowId = await member('unbound', TENANT_B, ['platform.view'], {
      externalSubject: null,
      email,
    });

    for (const email_verified of [undefined, false]) {
      const attacker = tokenFor({
        sub: `internal-dev:s4a-attacker-${randomUUID()}`,
        email,
        name: null,
        ...(email_verified === undefined ? {} : { email_verified }),
      });
      await businesses(attacker).expect(403);
      await adminGet(attacker, TENANT_B, '/platform/status').expect(403);
    }
    const row = await prisma.internalUser.findUniqueOrThrow({
      where: { id: rowId },
    });
    expect(row.externalSubject).toBeNull();
  });

  it('(1b) a verified email binds once; a second login with the same email cannot take it over', async () => {
    const email = `s4a-verified-${suffix}@example.test`;
    const rowId = await member('verified', TENANT_B, ['platform.view'], {
      externalSubject: null,
      email,
    });
    const firstSub = `internal-dev:s4a-first-${randomUUID()}`;
    const first = tokenFor({
      sub: firstSub,
      email,
      name: null,
      email_verified: true,
    });
    const listed = await businesses(first).expect(200);
    expect(JSON.stringify(listed.body)).toContain(TENANT_B);
    await adminGet(first, TENANT_B, '/platform/status').expect(200);
    expect(
      (await prisma.internalUser.findUniqueOrThrow({ where: { id: rowId } }))
        .externalSubject,
    ).toBe(firstSub);

    const second = tokenFor({
      sub: `internal-dev:s4a-second-${randomUUID()}`,
      email,
      name: null,
      email_verified: true,
    });
    await adminGet(second, TENANT_B, '/platform/status').expect(403);
    expect(
      (await prisma.internalUser.findUniqueOrThrow({ where: { id: rowId } }))
        .externalSubject,
    ).toBe(firstSub);
  });

  it('(2) staff permissions stay with the business that granted them', async () => {
    await adminGet(token('multi'), TENANT_A, '/platform/status').expect(200);
    await adminGet(token('multi'), TENANT_B, '/platform/status').expect(403);
    await adminGet(token('a-admin'), TENANT_B, '/platform/status').expect(403);
    await adminGet(token('b-admin'), TENANT_A, '/platform/status').expect(403);
  });

  // --- (3) platform status --------------------------------------------------

  it("(3) each business's platform totals count only its own locations", async () => {
    const countsFor = async (tenantId: string) => {
      const rows = await prisma.location.findMany({
        where: { tenantId },
        select: { isActive: true, isDigitalOrderingEnabled: true },
      });
      const active = rows.filter((r) => r.isActive);
      const digital = active.filter((r) => r.isDigitalOrderingEnabled).length;
      return {
        activeCount: active.length,
        inactiveCount: rows.length - active.length,
        digitalOrderingEnabledCount: digital,
        digitalOrderingDisabledCount: active.length - digital,
      };
    };
    const statusOf = async (key: string, tenantId: string) =>
      bodyOf<AdminPlatformStatus>(
        await adminGet(token(key), tenantId, '/platform/status').expect(200),
      ).locations;

    const beforeA = await statusOf('a-admin', TENANT_A);
    // Tenant B gets its own locations; Tenant A gets one more of its own.
    for (const [isActive, isDigitalOrderingEnabled] of [
      [true, true],
      [true, false],
      [false, false],
    ] as const) {
      await prisma.location.create({
        data: {
          tenantId: TENANT_B,
          name: `S4A B ${suffix}`,
          slug: `s4a-b-${randomUUID().slice(0, 8)}`,
          isActive,
          isDigitalOrderingEnabled,
        },
      });
    }
    const extraA = await prisma.location.create({
      data: {
        tenantId: TENANT_A,
        name: `S4A A ${suffix}`,
        slug: `s4a-a-${randomUUID().slice(0, 8)}`,
        isDigitalOrderingEnabled: true,
      },
    });
    locationIdsA.push(extraA.id);

    expect(await statusOf('b-admin', TENANT_B)).toEqual({
      activeCount: 2,
      inactiveCount: 1,
      digitalOrderingEnabledCount: 1,
      digitalOrderingDisabledCount: 1,
    });
    expect(await statusOf('b-admin', TENANT_B)).toEqual(
      await countsFor(TENANT_B),
    );
    const afterA = await statusOf('a-admin', TENANT_A);
    expect(afterA).toEqual(await countsFor(TENANT_A));
    // Tenant B's three locations never reach Tenant A's totals.
    expect(afterA.activeCount).toBe(beforeA.activeCount + 1);
    expect(afterA.inactiveCount).toBe(beforeA.inactiveCount);
  });

  // --- (4) branding: consent, CMS defaults, reports ---------------------------

  const inquiry = {
    firstName: 'S4A',
    lastName: 'Prospect',
    email: `s4a-prospect-${suffix}@example.test`,
    phone: '5550000001',
    city: 'Detroit',
    state: 'MI',
    country: 'US',
    preferredMarket: 'Detroit',
    consentAcknowledged: false,
  };

  it("(4) franchise consent names only the storefront's own business", async () => {
    const b = await request(appB.getHttpServer())
      .post('/api/v1/franchising/inquiries')
      .send(inquiry)
      .expect(400);
    expect(JSON.stringify(b.body)).toContain(
      `Please acknowledge that ${TEST_TENANT_B_NAME} may contact you regarding this inquiry.`,
    );
    expect(JSON.stringify(b.body)).not.toContain('Mocha House');

    const a = await request(appA.getHttpServer())
      .post('/api/v1/franchising/inquiries')
      .send(inquiry)
      .expect(400);
    expect(bodyOf<{ message: string }>(a).message).toBe(
      'Please acknowledge that Mocha House may contact you regarding this inquiry.',
    );
  });

  it("(4b) a business's default CMS content — and publishing it untouched — never carries another business's name", async () => {
    for (const key of ['franchising', 'home']) {
      const detail = bodyOf<AdminCmsPageDetail>(
        await adminGet(token('b-admin'), TENANT_B, `/content/${key}`).expect(
          200,
        ),
      );
      expect(JSON.stringify(detail.draftContent)).toContain(TEST_TENANT_B_NAME);
      expect(JSON.stringify(detail.draftContent)).not.toContain('Mocha House');
      expect(JSON.stringify(detail.draftContent)).not.toContain(
        '{{businessName}}',
      );
    }
    await request(appA.getHttpServer())
      .post('/api/v1/admin/content/franchising/publish')
      .set('Authorization', `Bearer ${token('b-admin')}`)
      .set('X-Tenant-Id', TENANT_B)
      .send({})
      .expect((res) => expect(res.status).toBeLessThan(300));
    const stored = await prisma.cmsPage.findUniqueOrThrow({
      where: { tenantId_key: { tenantId: TENANT_B, key: 'franchising' } },
    });
    expect(JSON.stringify(stored.publishedContent)).toContain(
      TEST_TENANT_B_NAME,
    );
    expect(JSON.stringify(stored.publishedContent)).not.toContain(
      'Mocha House',
    );
  });

  it("(4c) Mocha House's default CMS content reads exactly as before", () => {
    const franchising = JSON.stringify(
      defaultContentFor(CMS_PAGE_REGISTRY.franchising, 'Mocha House'),
    );
    for (const original of [
      'Mocha House is built around quality coffee, a warm neighborhood feel, and consistent day-to-day operations.',
      'As a franchisee, you would operate a Mocha House location using our brand, recipes, and operating know-how',
      'Interested in bringing Mocha House to your area? Start with a short inquiry — it only takes a few minutes.',
    ]) {
      expect(franchising).toContain(original);
    }
    expect(
      JSON.stringify(defaultContentFor(CMS_PAGE_REGISTRY.home, 'Mocha House')),
    ).toContain('"headline":"Welcome to Mocha House"');
    // The shared registry itself names no business.
    expect(JSON.stringify(CMS_PAGE_REGISTRY)).not.toContain('Mocha House');
  });

  it("(4d) report definitions name only the report's own business", async () => {
    for (const [path, label] of [
      [
        '/reports/operations-checklists',
        'Store operations data recorded in the',
      ],
      [
        '/reports/customer-growth',
        'Customer accounts and digital-platform orders recorded in the',
      ],
    ] as const) {
      const b = await adminGet(
        token('b-admin'),
        TENANT_B,
        `${path}${range}`,
      ).expect(200);
      const scopeB = bodyOf<{ source: { scopeLabel: string } }>(b).source
        .scopeLabel;
      expect(scopeB).toBe(`${label} ${TEST_TENANT_B_NAME} platform.`);

      const a = await adminGet(
        token('a-admin'),
        TENANT_A,
        `${path}${range}`,
      ).expect(200);
      expect(
        bodyOf<{ source: { scopeLabel: string } }>(a).source.scopeLabel,
      ).toBe(`${label} Mocha House platform.`);
    }
  });
});
