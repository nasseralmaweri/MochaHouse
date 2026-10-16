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
import { signPlatformDevJwt } from './infrastructure/platform-dev-jwt';
import { isDevPlatformAuthEnabled } from './infrastructure/platform-auth-provider-mode';

// SC1a — the CENTERIVO platform-operator boundary over real HTTP, on the real
// AppModule (so the real middleware exclusions and guards apply):
//   - an ACTIVE operator reaches GET /api/v1/platform/me;
//   - a tenant-staff token (even one holding the tenant's
//     "platform-administrator" role) and a customer token never do;
//   - a platform token never reaches a tenant-staff or customer route;
//   - missing / malformed / wrong-secret / expired / no-MFA tokens -> 401;
//   - unknown or DISABLED operators -> 403, re-checked on every request;
//   - the platform route ignores tenant headers and the storefront tenant;
//   - missing or shared Cognito configuration fails closed (503);
//   - security-relevant events are audited, with no token stored.
describe('Platform operator authentication (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const suffix = randomUUID().slice(0, 8);
  const PLATFORM_SECRET = `platform-spec-secret-${randomUUID()}`;

  const operatorIds: string[] = [];
  const internalUserIds: string[] = [];

  const subjectOf = (key: string) => `platform-dev:sc1a-${key}-${suffix}`;
  const platformToken = (
    key: string,
    opts: { mfa?: boolean; ttl?: number; secret?: string } = {},
  ) =>
    signPlatformDevJwt(
      { sub: subjectOf(key), mfa: opts.mfa ?? true },
      opts.secret ?? PLATFORM_SECRET,
      opts.ttl ?? 3600,
    );

  async function operator(
    key: string,
    status: 'ACTIVE' | 'DISABLED' = 'ACTIVE',
    provider: 'platform-dev' | 'cognito-platform' = 'platform-dev',
  ) {
    const row = await prisma.platformOperator.create({
      data: {
        externalProvider: provider,
        externalSubject: subjectOf(key),
        email: `sc1a-${key}-${suffix}@example.test`,
        displayName: `SC1a ${key}`,
        status,
      },
    });
    operatorIds.push(row.id);
    return row;
  }

  const http = () => request(app.getHttpServer());
  const platformMe = (token?: string) => {
    const req = http().get('/api/v1/platform/me');
    return token ? req.set('Authorization', `Bearer ${token}`) : req;
  };
  const auditFor = (where: object) =>
    prisma.platformAuditEvent.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });

  async function bootApp(): Promise<INestApplication<App>> {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const created = moduleRef.createNestApplication<INestApplication<App>>();
    await created.init();
    return created;
  }

  beforeAll(async () => {
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    app = await bootApp();
    prisma = app.get(PrismaService);
  });

  afterEach(() => {
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    delete process.env.PLATFORM_COGNITO_USER_POOL_ID;
    delete process.env.PLATFORM_COGNITO_CLIENT_ID;
  });

  afterAll(async () => {
    try {
      // The platform audit trail is append-only (and an operator it names
      // cannot be deleted), so this suite's operators are left DISABLED
      // rather than removed: unique per-run identities, disposable database.
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
    } finally {
      await app.close();
      process.env = { ...originalEnv };
    }
  });

  // --- valid access -------------------------------------------------------

  it('an ACTIVE operator gets their profile — no identity subject, no claims, not cacheable — and reading it writes nothing (SC1b)', async () => {
    const row = await operator('active');
    const token = platformToken('active');
    const res = await platformMe(token).expect(200);
    await platformMe(token).expect(200);
    expect(res.body).toEqual({
      operator: {
        id: row.id,
        email: row.email,
        displayName: 'SC1a active',
        status: 'ACTIVE',
      },
    });
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.stringify(res.body)).not.toContain(row.externalSubject);

    // SC1b — the portal reads /me on every page, so it is read-only: the
    // privileged access is audited once per sign-in (platform-sign-in.spec).
    const stored = await prisma.platformOperator.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(stored.lastAuthenticatedAt).toBeNull();
    expect(await auditFor({ actorPlatformOperatorId: row.id })).toEqual([]);
  });

  it('ignores tenant headers: a platform request carries no tenant, whatever the client sends', async () => {
    await operator('headers');
    const res = await platformMe(platformToken('headers'))
      .set('X-Tenant-Id', TENANT_1_MOCHA_HOUSE_ID)
      .set('X-Tenant-Id-Override', 'anything')
      .expect(200);
    expect(JSON.stringify(res.body)).not.toContain(TENANT_1_MOCHA_HOUSE_ID);
  });

  // --- credentials -----------------------------------------------------------

  it.each([
    ['no Authorization header', undefined],
    ['a non-Bearer scheme', 'Basic abc'],
    ['a Bearer header with no token', 'Bearer'],
    ['a garbage token', 'Bearer not-a-jwt'],
  ])('%s -> 401', async (_label, header) => {
    const req = http().get('/api/v1/platform/me');
    const res = await (header ? req.set('Authorization', header) : req);
    expect(res.status).toBe(401);
  });

  it('a token signed with another secret, an expired token, or one without MFA -> 401', async () => {
    await operator('creds');
    await platformMe(
      platformToken('creds', { secret: `other-${randomUUID()}` }),
    ).expect(401);
    await platformMe(platformToken('creds', { ttl: -10 })).expect(401);
    // MFA: the dev provider's stand-in for the pool's MFA requirement.
    await platformMe(platformToken('creds', { mfa: false })).expect(401);
  });

  // --- population separation ---------------------------------------------

  it('a tenant-staff token — even one holding the tenant\'s "platform-administrator" role — is refused on platform routes, while still working on its own', async () => {
    const internalSecret = process.env.INTERNAL_AUTH_DEV_JWT_SECRET!;
    const staffSubject = `internal-dev:sc1a-staff-${suffix}`;
    const user = await prisma.internalUser.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        externalProvider: 'internal-dev',
        externalSubject: staffSubject,
        email: `sc1a-staff-${suffix}@example.test`,
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
    // Even an operator row with the SAME subject string does not help: the
    // staff token never verifies at the platform boundary.
    await prisma.platformOperator
      .create({
        data: {
          externalProvider: 'platform-dev',
          externalSubject: staffSubject,
          email: `sc1a-staff-op-${suffix}@example.test`,
          status: 'ACTIVE',
        },
      })
      .then((row) => operatorIds.push(row.id));

    const staffToken = signInternalDevJwt(
      {
        sub: staffSubject,
        email: `sc1a-staff-${suffix}@example.test`,
        name: null,
        email_verified: true,
      },
      internalSecret,
      3600,
    );
    // Existing tenant-staff authentication is unchanged...
    await http()
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${staffToken}`)
      .expect(200);
    // ...and confers nothing on the platform boundary.
    await platformMe(staffToken).expect(401);
  });

  it('a customer token is refused on platform routes', async () => {
    const customerToken = signDevJwt(
      { sub: `sc1a-customer-${suffix}`, email: null, name: null },
      process.env.AUTH_DEV_JWT_SECRET!,
      3600,
    );
    await platformMe(customerToken).expect(401);
  });

  it('a platform token is refused on tenant-staff, Admin and customer routes', async () => {
    await operator('crossover');
    const token = platformToken('crossover');
    const bearer = `Bearer ${token}`;
    await http()
      .get('/api/v1/internal/me')
      .set('Authorization', bearer)
      .expect(401);
    await http()
      .get('/api/v1/internal/businesses')
      .set('Authorization', bearer)
      .expect(401);
    await http()
      .get('/api/v1/admin/platform/status')
      .set('Authorization', bearer)
      .set('X-Tenant-Id', TENANT_1_MOCHA_HOUSE_ID)
      .expect(401);
    await http()
      .get('/api/v1/customers/me')
      .set('Authorization', bearer)
      .expect(401);
  });

  // --- operator lifecycle --------------------------------------------------

  it('a DISABLED operator is refused (403) and audited; re-enabling restores access on the very next request', async () => {
    const row = await operator('lifecycle');
    const token = platformToken('lifecycle');
    await platformMe(token).expect(200);

    await prisma.platformOperator.update({
      where: { id: row.id },
      data: { status: 'DISABLED' },
    });
    const denied = await platformMe(token).expect(403);
    expect((denied.body as { message: string }).message).toBe(
      'This account is not permitted to access the platform area.',
    );
    const events = await auditFor({
      actorPlatformOperatorId: row.id,
      outcome: 'DENIED',
    });
    expect(events.map((e) => [e.action, e.reasonCode])).toEqual([
      ['platform.access.denied', 'OPERATOR_DISABLED'],
    ]);

    await prisma.platformOperator.update({
      where: { id: row.id },
      data: { status: 'ACTIVE' },
    });
    await platformMe(token).expect(200);
  });

  it('a verified identity with no operator record is refused with the same 403 and audited without an actor', async () => {
    const res = await platformMe(platformToken('nobody')).expect(403);
    expect((res.body as { message: string }).message).toBe(
      'This account is not permitted to access the platform area.',
    );
    const events = await auditFor({ identitySubject: subjectOf('nobody') });
    expect(
      events.map((e) => [
        e.reasonCode,
        e.actorPlatformOperatorId,
        e.identityProvider,
      ]),
    ).toEqual([['UNKNOWN_OPERATOR', null, 'platform-dev']]);
  });

  it('an operator is bound to its provider: a Cognito-provisioned operator is not reachable with a dev token for the same subject', async () => {
    await operator('provider-bound', 'ACTIVE', 'cognito-platform');
    await platformMe(platformToken('provider-bound')).expect(403);
  });

  it('an unauthenticated request writes no audit event', async () => {
    const before = await prisma.platformAuditEvent.count();
    await platformMe().expect(401);
    await platformMe('garbage').expect(401);
    expect(await prisma.platformAuditEvent.count()).toBe(before);
  });

  // --- configuration fails closed ------------------------------------------

  it('without PLATFORM_AUTH_PROVIDER=dev the dev token is never accepted: the Cognito boundary is unconfigured -> 503', async () => {
    await operator('no-dev');
    delete process.env.PLATFORM_AUTH_PROVIDER;
    const res = await platformMe(platformToken('no-dev')).expect(503);
    expect((res.body as { message: string }).message).toBe(
      'Platform authentication is not available.',
    );
    expect(JSON.stringify(res.body)).not.toContain('PLATFORM_COGNITO');
  });

  it.each(['AUTH_DEV_JWT_SECRET', 'INTERNAL_AUTH_DEV_JWT_SECRET'])(
    'a platform dev secret equal to %s fails closed at request time -> 503 (even where startup validation never runs)',
    async (other) => {
      await operator(`shared-secret-${other.length}`);
      const shared = process.env[other]!;
      process.env.PLATFORM_AUTH_DEV_JWT_SECRET = shared;
      await platformMe(
        platformToken(`shared-secret-${other.length}`, { secret: shared }),
      ).expect(503);
    },
  );

  it('a platform pool or app client shared with the staff pool fails closed -> 503', async () => {
    process.env.PLATFORM_AUTH_PROVIDER = 'cognito';
    process.env.PLATFORM_COGNITO_USER_POOL_ID =
      process.env.INTERNAL_COGNITO_USER_POOL_ID ?? 'us-east-1_SharedPool';
    process.env.INTERNAL_COGNITO_USER_POOL_ID =
      process.env.PLATFORM_COGNITO_USER_POOL_ID;
    process.env.PLATFORM_COGNITO_CLIENT_ID = 'platform-client-sc1a';
    try {
      await platformMe('a.b.c').expect(503);
    } finally {
      process.env.INTERNAL_COGNITO_USER_POOL_ID =
        originalEnv.INTERNAL_COGNITO_USER_POOL_ID;
      if (originalEnv.INTERNAL_COGNITO_USER_POOL_ID === undefined) {
        delete process.env.INTERNAL_COGNITO_USER_POOL_ID;
      }
    }
  });

  it('production can never select the dev platform provider', () => {
    const saved = { ...process.env };
    try {
      process.env.PLATFORM_AUTH_PROVIDER = 'dev';
      process.env.NODE_ENV = 'production';
      expect(isDevPlatformAuthEnabled()).toBe(false);
      process.env.NODE_ENV = saved.NODE_ENV;
      process.env.APP_ENV = 'production';
      expect(isDevPlatformAuthEnabled()).toBe(false);
    } finally {
      process.env = saved;
    }
  });

  // --- tenant independence -------------------------------------------------

  it("the platform route does not depend on the deployment's storefront tenant — it works while that tenant is SUSPENDED", async () => {
    const TENANT_S = '01a0db02-f800-7000-8000-7e570000051a';
    await prisma.tenant.upsert({
      where: { id: TENANT_S },
      update: { status: 'SUSPENDED', suspensionReason: 'BILLING' },
      create: {
        id: TENANT_S,
        slug: 'sc1a-test-tenant-suspended',
        name: 'SC1a Test Tenant (suspended)',
        status: 'SUSPENDED',
        suspensionReason: 'BILLING',
      },
    });
    const savedTenant = process.env.SINGLE_TENANT_ID;
    process.env.SINGLE_TENANT_ID = TENANT_S;
    const suspendedApp = await bootApp();
    try {
      await operator('suspended-storefront');
      // The storefront is closed...
      await request(suspendedApp.getHttpServer())
        .get('/api/v1/locations')
        .expect(503);
      // ...the platform boundary is not part of it.
      await request(suspendedApp.getHttpServer())
        .get('/api/v1/platform/me')
        .set('Authorization', `Bearer ${platformToken('suspended-storefront')}`)
        .expect(200);
    } finally {
      await suspendedApp.close();
      process.env.SINGLE_TENANT_ID = savedTenant;
      await removeTestTenant(prisma, TENANT_S);
    }
  });
});
