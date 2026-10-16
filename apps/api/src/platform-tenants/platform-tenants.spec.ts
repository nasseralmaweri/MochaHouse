import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { removeTestTenant } from '@mocha-house/testing';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';
import { signPlatformDevJwt } from '../platform-auth/infrastructure/platform-dev-jwt';
import type {
  PlatformTenantDetailResponse,
  PlatformTenantListResponse,
  PlatformTenantLocationListResponse,
} from '@mocha-house/contracts';

type Res = { body: unknown };
const list = (res: Res) => res.body as PlatformTenantListResponse;
const detail = (res: Res) => res.body as PlatformTenantDetailResponse;
const places = (res: Res) => res.body as PlatformTenantLocationListResponse;
const ANY_STRING: unknown = expect.any(String);
const idsOf = (res: Res) => list(res).tenants.map((t) => t.id);
const namesOf = (res: Res) => places(res).locations.map((l) => l.name);

// SC1c — the CENTERIVO tenant registry over real HTTP, on the real AppModule:
//   - an ACTIVE platform operator lists, searches, filters and pages every
//     business, and reads one business and its locations;
//   - tenant staff (even the tenant's "platform-administrator" role),
//     customers, unknown or DISABLED operators and anonymous callers never do;
//   - only registry fields leave the API — no customer, order or financial
//     data — and a business's locations are only ever its own;
//   - reading writes nothing (no tenant change, no audit row);
//   - query parameters are validated and bounded.
// Test businesses use test-only ids on the disposable test database.
describe('Platform tenant registry (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const PLATFORM_SECRET = `sc1c-platform-secret-${randomUUID()}`;

  const ALPHA = '01a0db02-f800-7000-8000-7e5700001c01';
  const BRAVO = '01a0db02-f800-7000-8000-7e5700001c02';
  const operatorIds: string[] = [];
  const internalUserIds: string[] = [];

  const subjectOf = (key: string) => `platform-dev:sc1c-${key}-${suffix}`;
  const tokenFor = (key: string) =>
    signPlatformDevJwt(
      { sub: subjectOf(key), mfa: true },
      PLATFORM_SECRET,
      3600,
    );

  async function operator(key: string, status: 'ACTIVE' | 'DISABLED') {
    const row = await prisma.platformOperator.create({
      data: {
        externalProvider: 'platform-dev',
        externalSubject: subjectOf(key),
        email: `sc1c-${key}-${suffix}@example.test`,
        status,
      },
    });
    operatorIds.push(row.id);
    return row;
  }

  const get = (path: string, token?: string) => {
    const req = request(app.getHttpServer()).get(`/api/v1/platform${path}`);
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };

  let active: string;

  beforeAll(async () => {
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);

    // Two test businesses, Alpha created before Bravo; Bravo suspended.
    await prisma.tenant.create({
      data: {
        id: ALPHA,
        slug: `sc1c-${suffix}-alpha`,
        name: `SC1c Registry Alpha ${suffix}`,
        status: 'ACTIVE',
      },
    });
    await prisma.tenant.create({
      data: {
        id: BRAVO,
        slug: `sc1c-${suffix}-bravo`,
        name: `SC1c Registry Bravo ${suffix}`,
        status: 'SUSPENDED',
        suspensionReason: 'BILLING',
      },
    });
    await prisma.location.createMany({
      data: [
        { tenantId: ALPHA, name: 'Alpha Downtown', slug: 'alpha-downtown' },
        {
          tenantId: ALPHA,
          name: 'Alpha Airport',
          slug: 'alpha-airport',
          isDigitalOrderingEnabled: false,
        },
        {
          tenantId: ALPHA,
          name: 'Alpha Closed',
          slug: 'alpha-closed',
          isActive: false,
        },
        { tenantId: BRAVO, name: 'Bravo Harbour', slug: 'bravo-harbour' },
      ],
    });

    await operator('active', 'ACTIVE');
    await operator('disabled', 'DISABLED');
    active = tokenFor('active');
  });

  afterAll(async () => {
    try {
      await prisma.platformOperator.updateMany({
        where: { id: { in: operatorIds } },
        data: { status: 'DISABLED' },
      });
      await prisma.internalUserRoleAssignment.deleteMany({
        where: { internalUserId: { in: internalUserIds } },
      });
      await prisma.internalUser.deleteMany({
        where: { id: { in: internalUserIds } },
      });
      await prisma.location.deleteMany({
        where: { tenantId: { in: [ALPHA, BRAVO] } },
      });
      await removeTestTenant(prisma, ALPHA);
      await removeTestTenant(prisma, BRAVO);
    } finally {
      await app.close();
      process.env = { ...originalEnv };
    }
  });

  // --- authorised access --------------------------------------------------

  it('an ACTIVE operator lists every business, oldest first — Mocha House (Tenant #1) leads — with registry totals', async () => {
    const res = await get('/tenants?pageSize=50', active).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const ids = idsOf(res);
    expect(ids[0]).toBe(TENANT_1_MOCHA_HOUSE_ID);
    expect(ids).toEqual(expect.arrayContaining([ALPHA, BRAVO]));
    expect(ids.indexOf(ALPHA)).toBeLessThan(ids.indexOf(BRAVO));

    const all = await prisma.tenant.count();
    const suspended = await prisma.tenant.count({
      where: { status: 'SUSPENDED' },
    });
    expect(res.body).toMatchObject({
      page: 1,
      pageSize: 50,
      total: all,
      registry: { total: all, active: all - suspended, suspended },
    });
  });

  it('returns registry fields only — no customer, order, payment, staff or loyalty data', async () => {
    const res = await get(`/tenants?q=${suffix}`, active).expect(200);
    expect(list(res).tenants).toEqual([
      {
        id: ALPHA,
        slug: `sc1c-${suffix}-alpha`,
        name: `SC1c Registry Alpha ${suffix}`,
        status: 'ACTIVE',
        suspensionReason: null,
        createdAt: ANY_STRING,
        locationCount: 3,
      },
      {
        id: BRAVO,
        slug: `sc1c-${suffix}-bravo`,
        name: `SC1c Registry Bravo ${suffix}`,
        status: 'SUSPENDED',
        suspensionReason: 'BILLING',
        createdAt: ANY_STRING,
        locationCount: 1,
      },
    ]);
    expect(Object.keys(list(res)).sort()).toEqual([
      'page',
      'pageSize',
      'registry',
      'tenants',
      'total',
    ]);
  });

  it('searches name or slug case-insensitively, filters by status, and pages', async () => {
    const byName = await get(
      `/tenants?q=${encodeURIComponent(`registry ALPHA ${suffix}`)}`,
      active,
    ).expect(200);
    expect(idsOf(byName)).toEqual([ALPHA]);

    const bySlug = await get(`/tenants?q=sc1c-${suffix}-bravo`, active).expect(
      200,
    );
    expect(idsOf(bySlug)).toEqual([BRAVO]);

    const suspended = await get(
      `/tenants?q=${suffix}&status=SUSPENDED`,
      active,
    ).expect(200);
    expect(list(suspended).total).toBe(1);
    expect(idsOf(suspended)).toEqual([BRAVO]);

    const allSuspended = await get(
      '/tenants?status=SUSPENDED&pageSize=50',
      active,
    ).expect(200);
    expect(
      list(allSuspended).tenants.every((t) => t.status === 'SUSPENDED'),
    ).toBe(true);

    const page1 = await get(`/tenants?q=${suffix}&pageSize=1`, active).expect(
      200,
    );
    const page2 = await get(
      `/tenants?q=${suffix}&pageSize=1&page=2`,
      active,
    ).expect(200);
    const page3 = await get(
      `/tenants?q=${suffix}&pageSize=1&page=3`,
      active,
    ).expect(200);
    expect(page1.body).toMatchObject({ total: 2, page: 1, pageSize: 1 });
    expect(idsOf(page1)).toEqual([ALPHA]);
    expect(idsOf(page2)).toEqual([BRAVO]);
    expect(idsOf(page3)).toEqual([]);

    const none = await get('/tenants?q=no such business zzz', active).expect(
      200,
    );
    expect(none.body).toMatchObject({ tenants: [], total: 0 });
  });

  it('refuses invalid or unbounded query parameters (400)', async () => {
    for (const query of [
      'q=100%25',
      'q=a_b',
      `q=${'x'.repeat(81)}`,
      'status=DELETED',
      'status=ACTIVE&status=SUSPENDED',
      'page=0',
      'pageSize=51',
      'pageSize=all',
    ]) {
      await get(`/tenants?${query}`, active).expect(400);
    }
    await get(`/tenants/${ALPHA}/locations?pageSize=500`, active).expect(400);
  });

  it("one business's detail: status and location counts; unknown and malformed ids are the same 404", async () => {
    const res = await get(`/tenants/${ALPHA}`, active).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual({
      tenant: {
        id: ALPHA,
        slug: `sc1c-${suffix}-alpha`,
        name: `SC1c Registry Alpha ${suffix}`,
        status: 'ACTIVE',
        suspensionReason: null,
        createdAt: ANY_STRING,
        updatedAt: ANY_STRING,
      },
      locations: { total: 3, active: 2, digitalOrderingEnabled: 1 },
    });

    const suspended = await get(`/tenants/${BRAVO}`, active).expect(200);
    expect(detail(suspended).tenant).toMatchObject({
      status: 'SUSPENDED',
      suspensionReason: 'BILLING',
    });

    for (const id of [
      '01a0db02-f800-7000-8000-7e5700001cff',
      'mocha-house',
      "1'%20OR%20'1'='1",
    ]) {
      const missing = await get(`/tenants/${id}`, active).expect(404);
      expect((missing.body as { message: string }).message).toBe(
        'Tenant not found.',
      );
      await get(`/tenants/${id}/locations`, active).expect(404);
    }
  });

  it("a business's locations are only ever its own, by name, paged", async () => {
    const alpha = await get(`/tenants/${ALPHA}/locations`, active).expect(200);
    expect(alpha.body).toMatchObject({ total: 3, page: 1, pageSize: 20 });
    expect(namesOf(alpha)).toEqual([
      'Alpha Airport',
      'Alpha Closed',
      'Alpha Downtown',
    ]);
    expect(Object.keys(places(alpha).locations[0]).sort()).toEqual([
      'createdAt',
      'id',
      'isActive',
      'isDigitalOrderingEnabled',
      'name',
      'slug',
    ]);

    const bravo = await get(`/tenants/${BRAVO}/locations`, active).expect(200);
    expect(namesOf(bravo)).toEqual(['Bravo Harbour']);

    const paged = await get(
      `/tenants/${ALPHA}/locations?pageSize=2&page=2`,
      active,
    ).expect(200);
    expect(namesOf(paged)).toEqual(['Alpha Downtown']);
  });

  it('ignores tenant headers: the registry is never narrowed or widened by X-Tenant-Id', async () => {
    const res = await get(`/tenants/${ALPHA}/locations`, active)
      .set('X-Tenant-Id', BRAVO)
      .expect(200);
    expect(places(res).total).toBe(3);
  });

  it('reading writes nothing: no business changes and no audit rows', async () => {
    const before = await prisma.tenant.findMany({
      where: { id: { in: [ALPHA, BRAVO] } },
      orderBy: { id: 'asc' },
    });
    const auditBefore = await prisma.platformAuditEvent.count();
    await get('/tenants', active).expect(200);
    await get(`/tenants/${ALPHA}`, active).expect(200);
    await get(`/tenants/${ALPHA}/locations`, active).expect(200);
    const after = await prisma.tenant.findMany({
      where: { id: { in: [ALPHA, BRAVO] } },
      orderBy: { id: 'asc' },
    });
    expect(after).toEqual(before);
    expect(await prisma.platformAuditEvent.count()).toBe(auditBefore);
  });

  // --- refused access -----------------------------------------------------

  const ROUTES = () => [
    '/tenants',
    `/tenants/${ALPHA}`,
    `/tenants/${ALPHA}/locations`,
  ];

  it('anonymous, malformed and no-MFA tokens are refused (401)', async () => {
    const noMfa = signPlatformDevJwt(
      { sub: subjectOf('active'), mfa: false },
      PLATFORM_SECRET,
      3600,
    );
    for (const path of ROUTES()) {
      await get(path).expect(401);
      await get(path, 'not-a-token').expect(401);
      await get(path, noMfa).expect(401);
    }
  });

  it('a DISABLED or unknown platform operator is refused (403), and the refusal is audited', async () => {
    const disabled = tokenFor('disabled');
    const auditBefore = await prisma.platformAuditEvent.count({
      where: { action: 'platform.access.denied' },
    });
    for (const path of ROUTES()) {
      await get(path, disabled).expect(403);
      await get(path, tokenFor('nobody')).expect(403);
    }
    expect(
      await prisma.platformAuditEvent.count({
        where: { action: 'platform.access.denied' },
      }),
    ).toBe(auditBefore + 6);
  });

  it('a tenant administrator — even with the "platform-administrator" role — and a customer are refused (401)', async () => {
    const staffSubject = `internal-dev:sc1c-staff-${suffix}`;
    const user = await prisma.internalUser.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        externalProvider: 'internal-dev',
        externalSubject: staffSubject,
        email: `sc1c-staff-${suffix}@example.test`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    internalUserIds.push(user.id);
    const role = await prisma.internalRole.findUniqueOrThrow({
      where: {
        tenantId_key: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          key: 'platform-administrator',
        },
      },
    });
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        internalUserId: user.id,
        roleId: role.id,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });
    const staffToken = signInternalDevJwt(
      {
        sub: staffSubject,
        email: `sc1c-staff-${suffix}@example.test`,
        name: null,
        email_verified: true,
      },
      process.env.INTERNAL_AUTH_DEV_JWT_SECRET!,
      3600,
    );
    // The staff token is real (it works on its own boundary)...
    await request(app.getHttpServer())
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(200);

    const customerToken = signDevJwt(
      { sub: `sc1c-customer-${suffix}`, email: null, name: null },
      process.env.AUTH_DEV_JWT_SECRET!,
      3600,
    );
    // ...and confers nothing on the registry.
    for (const path of ROUTES()) {
      await get(path, staffToken).expect(401);
      await get(path, customerToken).expect(401);
    }
  });
});
