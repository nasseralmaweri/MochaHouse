import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { AdminPlatformStatus } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { AdminPlatformModule } from './admin-platform.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';

type Status = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

// Administration → Platform Status (Milestone 5G): the read-only,
// business-facing platform posture view, over real local Postgres.
describe('Admin platform status (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'admin-platform-spec-internal-secret';
  const customerSecret = 'admin-platform-spec-customer-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const locationIds: string[] = [];
  const roles: Record<string, string> = {};

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );
  const customerToken = () =>
    signDevJwt(
      { sub: 'dev:x@example.com', email: 'x@example.com', name: null },
      customerSecret,
      3600,
    );

  async function makeUser(key: string, status: Status): Promise<string> {
    const user = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${key}`,
        email: `${key}@example.com`,
        displayName: key,
        status,
        activatedAt: status === 'ACTIVE' ? new Date() : null,
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  async function makeRole(
    displayName: string,
    permissionKeys: string[],
  ): Promise<string> {
    const role = await prisma.internalRole.create({
      data: {
        key: `platform-spec-${suffix}-${randomUUID()}`,
        displayName,
        permissions: {
          create: permissionKeys.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    roleIds.push(role.id);
    return role.id;
  }

  async function assign(
    userId: string,
    roleId: string,
    scope: { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null },
  ) {
    await prisma.internalUserRoleAssignment.create({
      data: { internalUserId: userId, roleId, ...scope },
    });
  }

  async function makeLocation(
    isActive: boolean,
    isDigitalOrderingEnabled: boolean,
  ): Promise<string> {
    const location = await prisma.location.create({
      data: {
        name: `Platform Spec Loc ${randomUUID()}`,
        slug: `platform-loc-${randomUUID()}`,
        isActive,
        isDigitalOrderingEnabled,
      },
    });
    locationIds.push(location.id);
    return location.id;
  }

  const getStatus = (key: string) =>
    request(app.getHttpServer())
      .get('/api/v1/admin/platform/status')
      .set('Authorization', `Bearer ${token(key)}`);

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
        AdminPlatformModule,
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    roles.platformView = await makeRole('Platform Viewer', ['platform.view']);
    roles.noPlatform = await makeRole('Orders Only', ['orders.view']);

    await makeUser(`viewer-${suffix}`, 'ACTIVE');
    await assign(userIds.at(-1)!, roles.platformView, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await makeUser(`locViewer-${suffix}`, 'ACTIVE');
    // A location for the LOCATION-scoped grant to reference.
    const scopeLoc = await makeLocation(true, true);
    await assign(userIds.at(-1)!, roles.platformView, {
      scopeType: 'LOCATION',
      scopeId: scopeLoc,
    });

    await makeUser(`noPerm-${suffix}`, 'ACTIVE');
    await assign(userIds.at(-1)!, roles.noPlatform, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await makeUser(`suspended-${suffix}`, 'SUSPENDED');
    await assign(userIds.at(-1)!, roles.platformView, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await makeUser(`disabled-${suffix}`, 'DISABLED');
    await assign(userIds.at(-1)!, roles.platformView, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
  }, 45_000);

  afterAll(async () => {
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    for (const id of roleIds) {
      await prisma.internalRolePermission.deleteMany({ where: { roleId: id } });
      await prisma.internalRole.deleteMany({ where: { id } });
    }
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.location.deleteMany({ where: { id: { in: locationIds } } });
    await app.close();
    process.env = { ...originalEnv };
  });

  // ---- Authorization ------------------------------------------

  it('an ACTIVE corporate user with platform.view gets 200', async () => {
    await getStatus(`viewer-${suffix}`).expect(200);
  });

  it('an ACTIVE user without platform.view gets 403', async () => {
    await getStatus(`noPerm-${suffix}`).expect(403);
  });

  it('a LOCATION-only platform.view grant cannot satisfy the CORPORATE-only route (403)', async () => {
    await getStatus(`locViewer-${suffix}`).expect(403);
  });

  it('a customer token is rejected (401)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/platform/status')
      .set('Authorization', `Bearer ${customerToken()}`)
      .expect(401);
  });

  it('a SUSPENDED internal user is blocked (403)', async () => {
    await getStatus(`suspended-${suffix}`).expect(403);
  });

  it('a DISABLED internal user is blocked (403)', async () => {
    await getStatus(`disabled-${suffix}`).expect(403);
  });

  // ---- Response shape + values ------------------------------

  it('returns the expected safe shape with plain-language labels', async () => {
    const res = await getStatus(`viewer-${suffix}`).expect(200);
    const body = res.body as AdminPlatformStatus;

    expect(Object.keys(body).sort()).toEqual(
      ['authentication', 'environmentLabel', 'isProduction', 'locations', 'payments'].sort(),
    );
    expect(body.environmentLabel).toBe('Development');
    expect(body.isProduction).toBe(false);
    // The spec env sets both auth providers to the local dev stand-in.
    expect(body.authentication.adminLabel).toBe('Local development authentication');
    expect(body.authentication.customerLabel).toBe('Local development authentication');
    expect(body.payments.providerLabel).toBe('Development payment provider');
    expect(body.payments.isDevelopmentStandIn).toBe(true);
    expect(Object.keys(body.authentication).sort()).toEqual([
      'adminLabel',
      'customerLabel',
    ]);
    expect(Object.keys(body.locations).sort()).toEqual([
      'activeCount',
      'digitalOrderingDisabledCount',
      'digitalOrderingEnabledCount',
      'inactiveCount',
    ]);
  });

  it('location counts and digital-ordering counts reflect the database', async () => {
    const before = (await getStatus(`viewer-${suffix}`).expect(200))
      .body as AdminPlatformStatus;

    await makeLocation(true, true); // active + DO on
    await makeLocation(true, true); // active + DO on
    await makeLocation(true, false); // active + DO off
    await makeLocation(false, true); // inactive (DO flag ignored for active tallies)

    const after = (await getStatus(`viewer-${suffix}`).expect(200))
      .body as AdminPlatformStatus;

    expect(after.locations.activeCount).toBe(before.locations.activeCount + 3);
    expect(after.locations.inactiveCount).toBe(
      before.locations.inactiveCount + 1,
    );
    expect(after.locations.digitalOrderingEnabledCount).toBe(
      before.locations.digitalOrderingEnabledCount + 2,
    );
    expect(after.locations.digitalOrderingDisabledCount).toBe(
      before.locations.digitalOrderingDisabledCount + 1,
    );
    // active == enabled + disabled, always
    expect(
      after.locations.digitalOrderingEnabledCount +
        after.locations.digitalOrderingDisabledCount,
    ).toBe(after.locations.activeCount);
  });

  // ---- Privacy -------------------------------------------

  it('never leaks a secret, credential, connection string or infrastructure identifier', async () => {
    // Poison the environment with sentinel secret-shaped values on vars the
    // status endpoint has no business reading. (The JWT secrets and
    // DATABASE_URL are left intact — the guard and Prisma still need them —
    // but the response is built only from provider mode + location counts,
    // so nothing from the environment can reach it.)
    process.env.REDIS_URL = 'redis://SENTINEL-redis-host:6379';
    process.env.AWS_COGNITO_INTERNAL_USER_POOL_ID = 'us-east-1_SENTINELPOOL';
    process.env.AWS_COGNITO_INTERNAL_CLIENT_ID = 'sentinelclientid1234';
    process.env.SENTINEL_PLATFORM_SECRET = 'do-not-leak-me-9f3a';
    try {
      const res = await getStatus(`viewer-${suffix}`).expect(200);
      const body = res.body as AdminPlatformStatus;
      const raw = JSON.stringify(body);

      for (const forbidden of [
        'SENTINEL',
        'sentinelclientid1234',
        'do-not-leak-me-9f3a',
        'redis://',
        'postgres://',
        'DATABASE_URL',
        'REDIS_URL',
        'JWT_SECRET',
        'CLIENT_ID',
        'USER_POOL',
        'process.env',
        'NODE_ENV',
        'AUTH_PROVIDER',
        internalSecret,
        customerSecret,
        String(originalEnv.DATABASE_URL),
      ]) {
        expect(raw).not.toContain(forbidden);
      }

      // Every label is drawn from a small fixed business vocabulary.
      expect(['Development', 'Production']).toContain(body.environmentLabel);
      for (const label of [
        body.authentication.adminLabel,
        body.authentication.customerLabel,
      ]) {
        expect(['Local development authentication', 'Amazon Cognito']).toContain(
          label,
        );
      }
      expect([
        'Development payment provider',
        'Live payment provider',
      ]).toContain(body.payments.providerLabel);
    } finally {
      if (originalEnv.REDIS_URL === undefined) {
        delete process.env.REDIS_URL;
      } else {
        process.env.REDIS_URL = originalEnv.REDIS_URL;
      }
      delete process.env.AWS_COGNITO_INTERNAL_USER_POOL_ID;
      delete process.env.AWS_COGNITO_INTERNAL_CLIENT_ID;
      delete process.env.SENTINEL_PLATFORM_SECRET;
    }
  });

  // ---- Permission regression ----------------------------

  it('Platform Administrator has platform.view; Store Manager does not', async () => {
    const pa = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'platform-administrator' },
      include: { permissions: true },
    });
    const sm = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'store-manager' },
      include: { permissions: true },
    });
    expect(pa.permissions.map((p) => p.permissionKey)).toContain('platform.view');
    expect(sm.permissions.map((p) => p.permissionKey)).not.toContain(
      'platform.view',
    );
  });
});
