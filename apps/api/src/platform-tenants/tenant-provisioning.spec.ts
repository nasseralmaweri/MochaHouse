import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  INTERNAL_PERMISSION_KEYS,
  STORE_MANAGER_ROLE,
  type InternalBusinessesResponse,
  type InternalMeResponse,
  type PlatformTenantProvisionResponse,
} from '@mocha-house/contracts';
import {
  TENANT_1_MOCHA_HOUSE_ID,
  checkTenantIntegrity,
} from '@mocha-house/database';
import {
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
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';

// SC1d — business provisioning end to end, on the real AppModule, in a
// SCRATCH database of its own (provisioned businesses get real ids and
// append-only provisioning records, so they never touch the shared test
// database). Covers: who may provision; what one transaction creates (and
// that a failure creates nothing); operation-scoped idempotency, slug
// conflicts and concurrency; the first owner's verified, case-insensitive,
// business-scoped sign-in; that ACTIVE turns on no storefront; tenant
// integrity.
// SC2a — the Founding plan's published version 1 (from the migrations).
const FOUNDING_VERSION = '01a0db02-f800-7000-8000-00000000f002';

describe('SC1d tenant provisioning (integration, scratch database)', () => {
  let scratch: ScratchDatabase;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const PLATFORM_SECRET = `sc1d-platform-${randomUUID()}`;
  const INTERNAL_SECRET = `sc1d-internal-${randomUUID()}`;
  const run = randomUUID().replace(/-/g, '').slice(0, 8);

  const operatorToken = (key: string) =>
    signPlatformDevJwt(
      { sub: `platform-dev:sc1d-${key}-${run}`, mfa: true },
      PLATFORM_SECRET,
      3600,
    );
  const staffToken = (key: string, email: string, verified = true) =>
    signInternalDevJwt(
      {
        sub: `internal-dev:sc1d-${key}-${run}`,
        email,
        name: null,
        email_verified: verified,
      },
      INTERNAL_SECRET,
      3600,
    );

  const provision = (
    body: Record<string, unknown>,
    key: string | null = randomUUID(),
    token: string | null = operatorToken('active'),
  ) => {
    let req = request(app.getHttpServer()).post('/api/v1/platform/tenants');
    if (token) req = req.set('Authorization', `Bearer ${token}`);
    if (key) req = req.set('Idempotency-Key', key);
    return req.send(body);
  };
  const business = (n: string) => ({
    name: `  SC1d   Coffee ${n}  `,
    slug: `SC1D-${n}-${run}`,
    ownerEmail: `  Owner.${n}-${run}@Example.COM `,
    ownerDisplayName: 'First Owner',
    // SC2a — every new business starts on a published plan.
    planVersionId: FOUNDING_VERSION,
  });
  const result = (res: { body: unknown }) =>
    res.body as PlatformTenantProvisionResponse;
  const tenantsWithSlug = (slug: string) =>
    prisma.tenant.count({ where: { slug } });

  beforeAll(async () => {
    scratch = await createScratchDatabase(
      process.env.DATABASE_URL!,
      'sc1d_provisioning',
    );
    await applyMigrations(
      scratch.url,
      listMigrations(
        join(__dirname, '../../../../packages/database/prisma/migrations'),
      ),
    );
    process.env.DATABASE_URL = scratch.url;
    process.env.PLATFORM_AUTH_PROVIDER = 'dev';
    process.env.PLATFORM_AUTH_DEV_JWT_SECRET = PLATFORM_SECRET;
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = INTERNAL_SECRET;
    // The limiter is covered by protected-routes.spec; this suite provisions
    // many times from one loopback address.
    process.env.RATE_LIMIT_ENABLED = '0';

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    await app.init();
    prisma = app.get(PrismaService);

    for (const [key, status] of [
      ['active', 'ACTIVE'],
      ['other', 'ACTIVE'],
      ['disabled', 'DISABLED'],
    ] as const) {
      await prisma.platformOperator.create({
        data: {
          externalProvider: 'platform-dev',
          externalSubject: `platform-dev:sc1d-${key}-${run}`,
          email: `sc1d-${key}-${run}@example.test`,
          status,
        },
      });
    }
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      process.env = { ...originalEnv };
      await scratch?.drop();
    }
  });

  // --- what one provisioning creates --------------------------------------

  it('creates the business, its built-in roles, its first owner, the provisioning record and the audit event — normalised, in one go', async () => {
    const key = randomUUID();
    const res = await provision(business('one'), key).expect(201);
    expect(res.headers['cache-control']).toBe('no-store');
    const body = result(res);
    expect(body).toEqual({
      tenant: {
        id: expect.any(String) as unknown,
        slug: `sc1d-one-${run}`,
        name: 'SC1d Coffee one',
        status: 'ACTIVE',
        createdAt: expect.any(String) as unknown,
      },
      owner: {
        email: `owner.one-${run}@example.com`,
        displayName: 'First Owner',
      },
      replayed: false,
    });
    const tenantId = body.tenant.id;

    const roles = await prisma.internalRole.findMany({
      where: { tenantId },
      include: { permissions: true },
      orderBy: { key: 'asc' },
    });
    expect(roles.map((r) => [r.key, r.isSystem])).toEqual([
      ['platform-administrator', true],
      ['store-manager', true],
    ]);
    expect(roles[0].permissions.map((p) => p.permissionKey).sort()).toEqual(
      [...INTERNAL_PERMISSION_KEYS].sort(),
    );
    expect(roles[1].permissions.map((p) => p.permissionKey).sort()).toEqual(
      [...STORE_MANAGER_ROLE.permissionKeys].sort(),
    );

    const users = await prisma.internalUser.findMany({
      where: { tenantId },
      include: { roleAssignments: { include: { role: true } } },
    });
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      email: `owner.one-${run}@example.com`,
      externalProvider: 'internal-dev',
      externalSubject: null,
      status: 'ACTIVE',
    });
    expect(
      users[0].roleAssignments.map((a) => [a.role.key, a.scopeType, a.scopeId]),
    ).toEqual([['platform-administrator', 'CORPORATE', null]]);

    const operator = await prisma.platformOperator.findUniqueOrThrow({
      where: { email: `sc1d-active-${run}@example.test` },
    });
    expect(
      await prisma.tenantProvisioningOperation.findUnique({
        where: { idempotencyKey: key },
      }),
    ).toMatchObject({
      provisionedTenantId: tenantId,
      actorPlatformOperatorId: operator.id,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    });
    expect(
      await prisma.platformAuditEvent.findMany({
        where: { targetType: 'tenant', targetId: tenantId },
      }),
    ).toEqual([
      expect.objectContaining({
        action: 'platform.tenant.provisioned',
        outcome: 'SUCCEEDED',
        actorPlatformOperatorId: operator.id,
      }),
    ]);

    // ACTIVE is a registry status only: nothing commercial comes with it.
    expect(await prisma.location.count({ where: { tenantId } })).toBe(0);
    expect(
      await prisma.loyaltyConfiguration.count({ where: { tenantId } }),
    ).toBe(0);
    expect(
      await prisma.giftCardConfiguration.count({ where: { tenantId } }),
    ).toBe(0);
    // SC2a — subscribed to the chosen plan, in the same transaction.
    expect(
      await prisma.tenantSubscription.findUnique({
        where: { subscriberTenantId: tenantId },
      }),
    ).toMatchObject({ planVersionId: FOUNDING_VERSION, status: 'ACTIVE' });
  });

  it('the first owner signs in with a VERIFIED email in any letter case — into this business only — and holds full administration', async () => {
    const body = result(await provision(business('owner')).expect(201));
    const tenantId = body.tenant.id;
    const mixedCase = `OWNER.Owner-${run}@example.com`;

    // Unverified, or an unrelated verified address: nothing.
    await request(app.getHttpServer())
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${staffToken('owner', mixedCase, false)}`)
      .set('X-Tenant-Id', tenantId)
      .expect(403);
    await request(app.getHttpServer())
      .get('/api/v1/internal/me')
      .set(
        'Authorization',
        `Bearer ${staffToken('stranger', `stranger-${run}@example.com`)}`,
      )
      .set('X-Tenant-Id', tenantId)
      .expect(403);
    const before = await prisma.internalUser.findFirstOrThrow({
      where: { tenantId },
    });
    expect(before.externalSubject).toBeNull();

    const token = staffToken('owner', mixedCase);
    const businesses = (
      await request(app.getHttpServer())
        .get('/api/v1/internal/businesses')
        .set('Authorization', `Bearer ${token}`)
        .expect(200)
    ).body as InternalBusinessesResponse;
    expect(businesses.businesses.map((b) => b.id)).toEqual([tenantId]);

    const me = (
      await request(app.getHttpServer())
        .get('/api/v1/internal/me')
        .set('Authorization', `Bearer ${token}`)
        .set('X-Tenant-Id', tenantId)
        .expect(200)
    ).body as InternalMeResponse;
    expect(me.business.id).toBe(tenantId);
    expect(me.user.email).toBe(`owner.owner-${run}@example.com`);
    expect(JSON.stringify(me.authorization)).toContain('users.manage_roles');

    const bound = await prisma.internalUser.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(bound.externalSubject).toBe(`internal-dev:sc1d-owner-${run}`);

    // Never Mocha House (Tenant #1), nor any other business.
    await request(app.getHttpServer())
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${token}`)
      .set('X-Tenant-Id', TENANT_1_MOCHA_HOUSE_ID)
      .expect(403);
  });

  it('ACTIVE does not open a storefront: the storefront still serves only its own business', async () => {
    const tenantId = result(await provision(business('store')).expect(201))
      .tenant.id;
    // Even once the owner adds a location, it is not on this storefront.
    await prisma.location.create({
      data: { tenantId, name: `SC1d Store ${run}`, slug: 'sc1d-store' },
    });
    const storefront = await request(app.getHttpServer())
      .get('/api/v1/locations')
      .set('X-Tenant-Id', tenantId);
    expect(JSON.stringify(storefront.body)).not.toContain(`SC1d Store ${run}`);
  });

  // --- idempotency, conflicts, concurrency ---------------------------------

  it('the same operation (same key, same request) returns the original result and creates nothing more', async () => {
    const key = randomUUID();
    const first = result(await provision(business('replay'), key).expect(201));
    // The same request in different letter case / spacing is the same
    // normalised request.
    const again = result(
      await provision(
        { ...business('replay'), slug: `sc1d-replay-${run}` },
        key,
      ).expect(200),
    );
    expect(again).toEqual({ ...first, replayed: true });
    expect(await tenantsWithSlug(`sc1d-replay-${run}`)).toBe(1);
    expect(
      await prisma.platformAuditEvent.count({
        where: { targetId: first.tenant.id },
      }),
    ).toBe(1);
  });

  it('the same key with a different request, or from another operator, is a conflict and creates nothing', async () => {
    const key = randomUUID();
    await provision(business('keyed'), key).expect(201);
    const different = await provision(
      { ...business('keyed'), name: 'Something else' },
      key,
    ).expect(409);
    expect(different.body).toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const otherOperator = await provision(
      business('keyed'),
      key,
      operatorToken('other'),
    ).expect(409);
    expect(otherOperator.body).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
    expect(await tenantsWithSlug(`sc1d-keyed-${run}`)).toBe(1);
  });

  it('a new operation with a slug already in use is a clear slug conflict — including Mocha House’s', async () => {
    await provision(business('taken')).expect(201);
    const res = await provision(business('taken')).expect(409);
    expect(res.body).toMatchObject({
      code: 'SLUG_TAKEN',
      message: 'Another business already uses that slug.',
    });
    await provision({ ...business('x'), slug: 'mocha-house' }).expect(409);
    expect(await tenantsWithSlug(`sc1d-taken-${run}`)).toBe(1);
  });

  it('concurrent retries of one operation create exactly one business', async () => {
    const key = randomUUID();
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => provision(business('race'), key)),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(4);
    expect(new Set(responses.map((r) => result(r).tenant.id)).size).toBe(1);
    expect(await tenantsWithSlug(`sc1d-race-${run}`)).toBe(1);
    expect(
      await prisma.tenantProvisioningOperation.count({
        where: { idempotencyKey: key },
      }),
    ).toBe(1);
  });

  it('concurrent different operations for one slug: one business, the rest slug conflicts', async () => {
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => provision(business('slugrace'))),
    );
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409]);
    for (const r of responses.filter((x) => x.status === 409)) {
      expect(r.body).toMatchObject({ code: 'SLUG_TAKEN' });
    }
    expect(await tenantsWithSlug(`sc1d-slugrace-${run}`)).toBe(1);
  });

  it('a failure inside the transaction leaves nothing behind — no business, role, owner, record or audit event', async () => {
    const slug = `sc1d-boom-${run}`;
    const original = prisma.$transaction.bind(prisma) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    const spy = jest
      .spyOn(prisma, '$transaction')
      .mockImplementationOnce((work: unknown, options: unknown) =>
        original(
          (tx: Record<string | symbol, unknown>) =>
            (work as (t: unknown) => Promise<unknown>)(
              new Proxy(tx, {
                get: (target, property) =>
                  property === 'platformAuditEvent'
                    ? {
                        create: () =>
                          Promise.reject(new Error('forced failure')),
                      }
                    : target[property],
              }),
            ),
          options,
        ),
      );
    const key = randomUUID();
    await provision({ ...business('boom'), slug }, key).expect(500);
    spy.mockRestore();

    expect(await tenantsWithSlug(slug)).toBe(0);
    expect(
      await prisma.internalUser.count({
        where: { email: `owner.boom-${run}@example.com` },
      }),
    ).toBe(0);
    expect(
      await prisma.tenantProvisioningOperation.count({
        where: { idempotencyKey: key },
      }),
    ).toBe(0);
    // ...and the same operation can then be completed normally.
    await provision({ ...business('boom'), slug }, key).expect(201);
  });

  // --- validation and access -----------------------------------------------

  it('refuses invalid requests (400) and creates nothing', async () => {
    const valid = business('valid');
    for (const [body, key] of [
      [valid, null],
      [valid, 'not-a-uuid'],
      [valid, randomUUID().toUpperCase()],
      [{ ...valid, slug: 'admin' }, randomUUID()],
      [{ ...valid, slug: 'platform' }, randomUUID()],
      [{ ...valid, slug: 'ab' }, randomUUID()],
      [{ ...valid, slug: 'bad_slug' }, randomUUID()],
      [{ ...valid, slug: '-leading' }, randomUUID()],
      [{ ...valid, name: 'x' }, randomUUID()],
      [{ ...valid, name: 'x'.repeat(121) }, randomUUID()],
      [{ ...valid, ownerEmail: 'not-an-email' }, randomUUID()],
      [{ ...valid, ownerEmail: undefined }, randomUUID()],
      [{ ...valid, ownerDisplayName: 'x'.repeat(121) }, randomUUID()],
    ] as const) {
      await provision(body as Record<string, unknown>, key).expect(400);
    }
    expect(await tenantsWithSlug(`sc1d-valid-${run}`)).toBe(0);
  });

  it('only an ACTIVE platform operator may provision: anonymous, staff, customer (401) and DISABLED operators (403) are refused', async () => {
    const body = business('denied');
    await provision(body, randomUUID(), null).expect(401);
    await provision(
      body,
      randomUUID(),
      staffToken('staff', `staff-${run}@example.com`),
    ).expect(401);
    await provision(
      body,
      randomUUID(),
      signDevJwt(
        { sub: `sc1d-customer-${run}`, email: null, name: null },
        process.env.AUTH_DEV_JWT_SECRET!,
        3600,
      ),
    ).expect(401);
    await provision(body, randomUUID(), operatorToken('disabled')).expect(403);
    expect(await tenantsWithSlug(`sc1d-denied-${run}`)).toBe(0);
  });

  it('tenant integrity stays CLEAN after every provisioning above', async () => {
    const report = await withScratchClient(scratch.url, (client) =>
      checkTenantIntegrity(client),
    );
    expect([report.verdict, report.violations, report.uncheckedRows]).toEqual([
      'clean',
      0,
      0,
    ]);
  });
});
