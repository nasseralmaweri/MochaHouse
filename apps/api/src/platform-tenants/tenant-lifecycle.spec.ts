import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  PLATFORM_ADMINISTRATOR_ROLE,
  type InternalMeResponse,
  type PlatformTenantLifecycleResponse,
  type PlatformTenantOwnerEmailResponse,
  type PlatformTenantStatusChangeResponse,
} from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { removeTestTenant } from '@mocha-house/testing';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { signPlatformDevJwt } from '../platform-auth/infrastructure/platform-dev-jwt';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';

// SC1e — a business's lifecycle over real HTTP, on the real AppModule:
// suspend (with a reason, never Tenant #1), reactivate, correct a
// never-signed-in first owner's email; recent sign-in required for every
// change; idempotent no-ops; audit events; and the effect on staff access.
// Test businesses use test-only ids on the disposable test database.
describe('SC1e tenant lifecycle (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc1e-platform-${randomUUID()}`;
  const INTERNAL_SECRET = `sc1e-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);
  const ALPHA = '01a0db02-f800-7000-8000-7e5700001e01';
  const BRAVO = '01a0db02-f800-7000-8000-7e5700001e02';
  const operatorIds: string[] = [];

  // iat: a sign-in time (epoch seconds), or 'none' for a token that does
  // not say when the operator signed in.
  const operatorToken = (key: string, iat?: number | 'none') =>
    signPlatformDevJwt(
      {
        sub: `platform-dev:sc1e-${key}-${run}`,
        mfa: true,
        ...(iat === 'none'
          ? { iat: undefined }
          : iat === undefined
            ? {}
            : { iat }),
      },
      PLATFORM_SECRET,
      3600,
    );
  const fresh = () => operatorToken('active');
  const call = (
    method: 'get' | 'post',
    path: string,
    token: string | null = fresh(),
    body?: object,
  ) => {
    let req = request(app.getHttpServer())[method](
      `/api/v1/platform/tenants${path}`,
    );
    if (token) req = req.set('Authorization', `Bearer ${token}`);
    return body ? req.send(body) : req;
  };
  const lifecycle = async (tenantId: string) =>
    (await call('get', `/${tenantId}/lifecycle`).expect(200))
      .body as PlatformTenantLifecycleResponse;
  // This run's events only: the trail is append-only and the test-only
  // business ids are fixed, so earlier runs' events remain.
  const auditFor = (tenantId: string) =>
    prisma.platformAuditEvent.findMany({
      where: {
        targetType: 'tenant',
        targetId: tenantId,
        actorPlatformOperatorId: { in: operatorIds },
      },
      orderBy: { createdAt: 'asc' },
    });

  async function business(id: string, slug: string) {
    await prisma.tenant.create({
      data: {
        id,
        slug: `${slug}-${run}`,
        name: `SC1e ${slug}`,
        status: 'ACTIVE',
      },
    });
    const role = await prisma.internalRole.create({
      data: {
        tenantId: id,
        key: PLATFORM_ADMINISTRATOR_ROLE.key,
        displayName: PLATFORM_ADMINISTRATOR_ROLE.displayName,
        isSystem: true,
        permissions: {
          create: [{ permissionKey: 'users.manage_roles' }],
        },
      },
    });
    return role.id;
  }

  async function staff(
    tenantId: string,
    email: string,
    opts: { roleId?: string; subject?: string | null } = {},
  ) {
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: opts.subject ?? null,
        email,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    if (opts.roleId) {
      await prisma.internalUserRoleAssignment.create({
        data: {
          tenantId,
          internalUserId: user.id,
          roleId: opts.roleId,
          scopeType: 'CORPORATE',
          scopeId: null,
        },
      });
    }
    return user;
  }

  let alphaRole: string;
  let bravoRole: string;

  beforeAll(async () => {
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
      const row = await prisma.platformOperator.create({
        data: {
          externalProvider: 'platform-dev',
          externalSubject: `platform-dev:sc1e-${key}-${run}`,
          email: `sc1e-${key}-${run}@example.test`,
          status,
        },
      });
      operatorIds.push(row.id);
    }
    alphaRole = await business(ALPHA, 'sc1e-alpha');
    bravoRole = await business(BRAVO, 'sc1e-bravo');
  });

  afterAll(async () => {
    try {
      await prisma.platformOperator.updateMany({
        where: { id: { in: operatorIds } },
        data: { status: 'DISABLED' },
      });
      for (const tenantId of [ALPHA, BRAVO]) {
        await prisma.internalUserRoleAssignment.deleteMany({
          where: { tenantId },
        });
        await prisma.internalUser.deleteMany({ where: { tenantId } });
        await prisma.internalRole.deleteMany({ where: { tenantId } });
        await removeTestTenant(prisma, tenantId);
      }
    } finally {
      await app.close();
      process.env = { ...originalEnv };
    }
  });

  // --- read ------------------------------------------------------------------

  it('reads status, protection, the first owner and impact counts (counts only)', async () => {
    const owner = await staff(ALPHA, `owner-${run}@example.com`, {
      roleId: alphaRole,
    });
    // A later administrator is not the FIRST owner.
    await staff(ALPHA, `second-${run}@example.com`, { roleId: alphaRole });
    expect(await lifecycle(ALPHA)).toEqual({
      tenantId: ALPHA,
      status: 'ACTIVE',
      suspensionReason: null,
      protected: false,
      owner: {
        id: owner.id,
        email: `owner-${run}@example.com`,
        displayName: null,
        signedIn: false,
      },
      impact: { openOrders: 0, pendingNotifications: 0 },
    });

    const mocha = await lifecycle(TENANT_1_MOCHA_HOUSE_ID);
    expect(mocha.protected).toBe(true);
    expect(mocha.impact).toEqual({
      openOrders: await prisma.order.count({
        where: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          status: { in: ['RECEIVED', 'ACCEPTED', 'PREPARING', 'READY'] },
        },
      }),
      pendingNotifications: await prisma.outboxEvent.count({
        where: { tenantId: TENANT_1_MOCHA_HOUSE_ID, status: 'PENDING' },
      }),
    });
  });

  // --- suspend / reactivate ------------------------------------------------

  it('suspends with a reason (audited once), locks staff out, and reactivates (audited once) — repeats change nothing', async () => {
    const member = await staff(BRAVO, `member-${run}@example.com`, {
      roleId: bravoRole,
      subject: `internal-dev:sc1e-member-${run}`,
    });
    const staffToken = signInternalDevJwt(
      {
        sub: `internal-dev:sc1e-member-${run}`,
        email: member.email,
        name: null,
        email_verified: true,
      },
      INTERNAL_SECRET,
      3600,
    );
    const staffMe = () =>
      request(app.getHttpServer())
        .get('/api/v1/internal/me')
        .set('Authorization', `Bearer ${staffToken}`)
        .set('X-Tenant-Id', BRAVO);
    await staffMe().expect(200);

    const suspended = (
      await call('post', `/${BRAVO}/suspend`, fresh(), {
        reason: 'BILLING',
      }).expect(200)
    ).body as PlatformTenantStatusChangeResponse;
    expect(suspended).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'BILLING',
      changed: true,
    });
    // SC3c-1 — a BILLING suspension keeps the narrow operational wind-down
    // (the session, orders, billing) and nothing else.
    expect(
      ((await staffMe().expect(200)).body as InternalMeResponse).business
        .access,
    ).toBe('BILLING_WIND_DOWN');
    const staffLocations = () =>
      request(app.getHttpServer())
        .get('/api/v1/admin/locations')
        .set('Authorization', `Bearer ${staffToken}`)
        .set('X-Tenant-Id', BRAVO);
    expect((await staffLocations().expect(403)).body).toMatchObject({
      code: 'BUSINESS_BILLING_SUSPENDED',
    });

    // The same reason again: nothing changes, nothing is audited.
    expect(
      (
        await call('post', `/${BRAVO}/suspend`, fresh(), {
          reason: 'BILLING',
        }).expect(200)
      ).body,
    ).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'BILLING',
      changed: false,
    });
    // SC3c-1 — a SECURITY suspension takes precedence over the BILLING one
    // (so a payment can never lift it), and the wind-down access ends.
    expect(
      (
        await call('post', `/${BRAVO}/suspend`, fresh(), {
          reason: 'SECURITY',
        }).expect(200)
      ).body,
    ).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'SECURITY',
      changed: true,
    });
    await staffMe().expect(403);
    // Once SECURITY, nothing replaces it.
    expect(
      (
        await call('post', `/${BRAVO}/suspend`, fresh(), {
          reason: 'BILLING',
        }).expect(200)
      ).body,
    ).toEqual({
      status: 'SUSPENDED',
      suspensionReason: 'SECURITY',
      changed: false,
    });

    const reactivated = (await call('post', `/${BRAVO}/reactivate`).expect(200))
      .body as PlatformTenantStatusChangeResponse;
    expect(reactivated).toEqual({
      status: 'ACTIVE',
      suspensionReason: null,
      changed: true,
    });
    await staffMe().expect(200);
    expect(
      (await call('post', `/${BRAVO}/reactivate`).expect(200)).body,
    ).toEqual({
      status: 'ACTIVE',
      suspensionReason: null,
      changed: false,
    });

    const operator = operatorIds[0];
    expect(
      (await auditFor(BRAVO)).map((e) => [
        e.action,
        e.outcome,
        e.reasonCode,
        e.actorPlatformOperatorId,
      ]),
    ).toEqual([
      ['platform.tenant.suspended', 'SUCCEEDED', 'BILLING', operator],
      ['platform.tenant.suspended', 'SUCCEEDED', 'SECURITY', operator],
      ['platform.tenant.reactivated', 'SUCCEEDED', 'SECURITY', operator],
    ]);
  });

  it('concurrent suspensions settle on one change and one audit event', async () => {
    const before = (await auditFor(ALPHA)).length;
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        call('post', `/${ALPHA}/suspend`, fresh(), { reason: 'REQUESTED' }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(
      responses.filter(
        (r) => (r.body as PlatformTenantStatusChangeResponse).changed,
      ),
    ).toHaveLength(1);
    expect((await auditFor(ALPHA)).length).toBe(before + 1);
    await call('post', `/${ALPHA}/reactivate`).expect(200);
  });

  it('never suspends Tenant #1 (Mocha House)', async () => {
    const res = await call(
      'post',
      `/${TENANT_1_MOCHA_HOUSE_ID}/suspend`,
      fresh(),
      {
        reason: 'SECURITY',
      },
    ).expect(409);
    expect(res.body).toMatchObject({ code: 'TENANT_PROTECTED' });
    expect(
      (
        await prisma.tenant.findUniqueOrThrow({
          where: { id: TENANT_1_MOCHA_HOUSE_ID },
        })
      ).status,
    ).toBe('ACTIVE');
  });

  it('refuses a missing or unknown reason (400) and unknown or malformed businesses (404)', async () => {
    for (const body of [{}, { reason: 'bad' }, { reason: 'billing' }]) {
      await call('post', `/${ALPHA}/suspend`, fresh(), body).expect(400);
    }
    for (const id of ['01a0db02-f800-7000-8000-7e5700001eff', 'nope']) {
      await call('get', `/${id}/lifecycle`).expect(404);
      await call('post', `/${id}/suspend`, fresh(), {
        reason: 'BILLING',
      }).expect(404);
      await call('post', `/${id}/reactivate`).expect(404);
    }
  });

  // --- recent sign-in -------------------------------------------------------

  it('every change needs a sign-in within 15 minutes; reading does not', async () => {
    const now = Math.floor(Date.now() / 1000);
    const stale = operatorToken('active', now - 16 * 60);
    const unknown = operatorToken('active', 'none');
    for (const token of [stale, unknown]) {
      for (const [path, body] of [
        [`/${ALPHA}/suspend`, { reason: 'BILLING' }],
        [`/${ALPHA}/reactivate`, {}],
        [
          `/${ALPHA}/owner-email`,
          { ownerId: randomUUID(), email: 'x@example.com' },
        ],
      ] as const) {
        const res = await call('post', path, token, body).expect(401);
        expect(res.body).toMatchObject({ code: 'REAUTHENTICATION_REQUIRED' });
      }
      await call('get', `/${ALPHA}/lifecycle`, token).expect(200);
    }
    await call(
      'post',
      `/${ALPHA}/suspend`,
      operatorToken('active', now - 14 * 60),
      {
        reason: 'BILLING',
      },
    ).expect(200);
    await call('post', `/${ALPHA}/reactivate`).expect(200);
    expect((await lifecycle(ALPHA)).status).toBe('ACTIVE');
  });

  // --- owner email correction ----------------------------------------------

  it("corrects a never-signed-in first owner's email (normalised, audited once); repeats change nothing", async () => {
    const { owner } = await lifecycle(ALPHA);
    const res = (
      await call('post', `/${ALPHA}/owner-email`, fresh(), {
        ownerId: owner!.id,
        email: `  Fixed.Owner-${run}@Example.COM `,
      }).expect(200)
    ).body as PlatformTenantOwnerEmailResponse;
    expect(res).toEqual({
      owner: { ...owner, email: `fixed.owner-${run}@example.com` },
      changed: true,
    });
    expect(
      (
        await prisma.internalUser.findUniqueOrThrow({
          where: { id: owner!.id },
        })
      ).email,
    ).toBe(`fixed.owner-${run}@example.com`);
    const again = (
      await call('post', `/${ALPHA}/owner-email`, fresh(), {
        ownerId: owner!.id,
        email: `fixed.owner-${run}@example.com`,
      }).expect(200)
    ).body as PlatformTenantOwnerEmailResponse;
    expect(again.changed).toBe(false);
    expect(
      (await auditFor(ALPHA)).filter(
        (e) => e.action === 'platform.tenant.owner_email_corrected',
      ),
    ).toHaveLength(1);
  });

  it('refuses an address another staff member of the business uses (any case), a non-owner, and bad input', async () => {
    const { owner } = await lifecycle(ALPHA);
    const clash = await call('post', `/${ALPHA}/owner-email`, fresh(), {
      ownerId: owner!.id,
      email: `SECOND-${run}@example.com`,
    }).expect(409);
    expect(clash.body).toMatchObject({ code: 'OWNER_EMAIL_IN_USE' });

    const second = await prisma.internalUser.findFirstOrThrow({
      where: { tenantId: ALPHA, email: `second-${run}@example.com` },
    });
    await call('post', `/${ALPHA}/owner-email`, fresh(), {
      ownerId: second.id,
      email: `other-${run}@example.com`,
    }).expect(404);
    // Another business's owner id through this business: not found.
    await call('post', `/${BRAVO}/owner-email`, fresh(), {
      ownerId: owner!.id,
      email: `other-${run}@example.com`,
    }).expect(404);
    for (const body of [
      { ownerId: owner!.id, email: 'not-an-email' },
      { ownerId: 'nope', email: `ok-${run}@example.com` },
      {},
    ]) {
      await call('post', `/${ALPHA}/owner-email`, fresh(), body).expect(400);
    }
  });

  it('refuses once the owner has signed in, and changes nothing', async () => {
    const { owner } = await lifecycle(ALPHA);
    await prisma.internalUser.update({
      where: { id: owner!.id },
      data: { externalSubject: `internal-dev:sc1e-owner-${run}` },
    });
    expect((await lifecycle(ALPHA)).owner?.signedIn).toBe(true);
    const res = await call('post', `/${ALPHA}/owner-email`, fresh(), {
      ownerId: owner!.id,
      email: `late-${run}@example.com`,
    }).expect(409);
    expect(res.body).toMatchObject({ code: 'OWNER_ALREADY_SIGNED_IN' });
    expect(
      (
        await prisma.internalUser.findUniqueOrThrow({
          where: { id: owner!.id },
        })
      ).email,
    ).toBe(owner!.email);
  });

  // --- access -------------------------------------------------------------

  it('only an ACTIVE platform operator: anonymous and staff (401), DISABLED operator (403)', async () => {
    const staffToken = signInternalDevJwt(
      {
        sub: `internal-dev:sc1e-x-${run}`,
        email: `x-${run}@example.com`,
        name: null,
        email_verified: true,
      },
      INTERNAL_SECRET,
      3600,
    );
    for (const token of [null, staffToken]) {
      await call('get', `/${ALPHA}/lifecycle`, token).expect(401);
      await call('post', `/${ALPHA}/suspend`, token, {
        reason: 'BILLING',
      }).expect(401);
    }
    await call('post', `/${ALPHA}/suspend`, operatorToken('disabled'), {
      reason: 'BILLING',
    }).expect(403);
    expect((await lifecycle(ALPHA)).status).toBe('ACTIVE');
  });
});
