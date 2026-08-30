import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  INTERNAL_PERMISSION_KEYS,
  type InternalMeResponse,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from './internal-auth.module';
import { signInternalDevJwt } from './infrastructure/internal-dev-jwt';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';

// GET /api/v1/internal/me — the Milestone 5C authorization summary. Real
// local Postgres. Proves the summary is derived correctly per scope and
// that 5A/5B semantics (401 for bad tokens, 403 for non-ACTIVE, customer
// isolation) are unchanged.
describe('GET /api/v1/internal/me — authorization summary (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'internal-me-spec-internal-secret';
  const customerSecret = 'internal-me-spec-customer-secret';
  const suffix = randomUUID();

  let locA: string;
  let locB: string;
  let inactiveLoc: string;
  const users: Record<string, string> = {};
  const roleIds: string[] = [];

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );

  async function createUser(key: string, status: 'ACTIVE' | 'SUSPENDED') {
    const user = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${key}`,
        email: `${key}@example.com`,
        status,
        activatedAt: new Date(),
      },
    });
    users[key] = user.id;
    return user.id;
  }

  async function grant(
    userId: string,
    permissions: readonly string[],
    scope: { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null },
  ) {
    const role = await prisma.internalRole.create({
      data: {
        key: `internal-me-${suffix}-${randomUUID()}`,
        displayName: 'internal-me spec role',
        permissions: {
          create: permissions.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    roleIds.push(role.id);
    await prisma.internalUserRoleAssignment.create({
      data: {
        internalUserId: userId,
        roleId: role.id,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
      },
    });
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = customerSecret;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [PrismaModule, CustomerAuthModule, InternalAuthModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    locA = (
      await prisma.location.create({
        data: {
          name: `ME Spec A ${suffix}`,
          slug: `me-a-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;
    locB = (
      await prisma.location.create({
        data: {
          name: `ME Spec B ${suffix}`,
          slug: `me-b-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: false,
        },
      })
    ).id;
    inactiveLoc = (
      await prisma.location.create({
        data: {
          name: `ME Spec Inactive ${suffix}`,
          slug: `me-inactive-${suffix}`,
          isActive: false,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;

    const corp = await createUser(`corp-${suffix}`, 'ACTIVE');
    await grant(corp, INTERNAL_PERMISSION_KEYS, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    const loc = await createUser(`loc-${suffix}`, 'ACTIVE');
    await grant(loc, ['orders.view'], {
      scopeType: 'LOCATION',
      scopeId: locA,
    });
    await grant(loc, ['catalog.overrides.manage'], {
      scopeType: 'LOCATION',
      scopeId: locB,
    });
    // A grant pointing at an INACTIVE location — must be filtered out.
    await grant(loc, ['orders.view'], {
      scopeType: 'LOCATION',
      scopeId: inactiveLoc,
    });

    await createUser(`norole-${suffix}`, 'ACTIVE');
    const suspended = await createUser(`suspended-${suffix}`, 'SUSPENDED');
    await grant(suspended, INTERNAL_PERMISSION_KEYS, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
  });

  afterAll(async () => {
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: Object.values(users) } },
    });
    for (const id of roleIds) {
      await prisma.internalRolePermission.deleteMany({ where: { roleId: id } });
      await prisma.internalRole.deleteMany({ where: { id } });
    }
    await prisma.internalUser.deleteMany({
      where: { id: { in: Object.values(users) } },
    });
    await prisma.location.deleteMany({
      where: { id: { in: [locA, locB, inactiveLoc] } },
    });
    await app.close();
    process.env = { ...originalEnv };
  });

  it('401 with no token (unchanged)', async () => {
    await request(app.getHttpServer()).get('/api/v1/internal/me').expect(401);
  });

  it('401 with a valid customer token (isolation, unchanged)', async () => {
    const customerToken = signDevJwt(
      { sub: 'dev:x@example.com', email: 'x@example.com', name: null },
      customerSecret,
      3600,
    );
    await request(app.getHttpServer())
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${customerToken}`)
      .expect(401);
  });

  it('403 for a SUSPENDED user even with a full corporate role (lifecycle unchanged)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${token(`suspended-${suffix}`)}`)
      .expect(403);
  });

  it('CORPORATE user: all effective permissions, isCorporate true, all active locations', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${token(`corp-${suffix}`)}`)
      .expect(200);
    const body = res.body as InternalMeResponse;

    expect(body.user.email).toBe(`corp-${suffix}@example.com`);
    expect(body.user.status).toBe('ACTIVE');
    expect(body.authorization.permissions.sort()).toEqual(
      [...INTERNAL_PERMISSION_KEYS].sort(),
    );
    expect(body.authorization.isCorporate).toBe(true);

    const ids = body.authorization.locations.map((l) => l.id);
    expect(ids).toContain(locA);
    expect(ids).toContain(locB);
    expect(ids).not.toContain(inactiveLoc);
    // Corporate sees every active location, so at least the seeded one plus
    // the two active spec locations.
    const activeCount = await prisma.location.count({
      where: { isActive: true },
    });
    expect(body.authorization.locations).toHaveLength(activeCount);
  });

  it('LOCATION user: only effective permissions, isCorporate false, only active granted locations', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${token(`loc-${suffix}`)}`)
      .expect(200);
    const body = res.body as InternalMeResponse;

    expect(body.authorization.permissions.sort()).toEqual([
      'catalog.overrides.manage',
      'orders.view',
    ]);
    expect(body.authorization.isCorporate).toBe(false);

    const ids = body.authorization.locations.map((l) => l.id).sort();
    expect(ids).toEqual([locA, locB].sort());
    expect(ids).not.toContain(inactiveLoc);
    // The location payload carries the digital-ordering flag the dashboard
    // needs for Needs Attention.
    const b = body.authorization.locations.find((l) => l.id === locB);
    expect(b?.isDigitalOrderingEnabled).toBe(false);

    // Per-permission scope: orders.view is at locA (the inactive-location
    // grant is filtered out), catalog.overrides.manage is at locB — the two
    // scopes stay distinct, so the web can't infer overrides.manage at locA
    // or orders.view at locB.
    expect(body.authorization.capabilities).toEqual({
      'orders.view': { corporate: false, locationIds: [locA] },
      'catalog.overrides.manage': { corporate: false, locationIds: [locB] },
    });
  });

  it('NO-ROLE ACTIVE user: 200 with empty summary', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${token(`norole-${suffix}`)}`)
      .expect(200);
    const body = res.body as InternalMeResponse;

    expect(body.user.status).toBe('ACTIVE');
    expect(body.authorization).toEqual({
      permissions: [],
      isCorporate: false,
      locations: [],
      capabilities: {},
    });
  });

  it('CORPORATE user: every capability is corporate:true across all active locations', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${token(`corp-${suffix}`)}`)
      .expect(200);
    const body = res.body as InternalMeResponse;

    for (const key of INTERNAL_PERMISSION_KEYS) {
      expect(body.authorization.capabilities[key]).toEqual({
        corporate: true,
        locationIds: [],
      });
    }
  });
});
