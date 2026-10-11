import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { InternalUsersModule } from './internal-users.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';

// Security follow-up F-2 — concurrent access changes. Simultaneous identical
// requests (several admins, double-clicks, retried HTTP calls) must never
// create a duplicate grant, leave authorization half-changed, or surface a
// database error. Each request gets exactly the answer the same request
// would get if it ran alone, before or after the others: 201 for the one
// that creates the grant, the ordinary 409 "already has that access" for
// the rest; one revocation succeeds (201, the remove action is a POST) and
// the others get the ordinary 404.
// All requests go through the real HTTP stack, so status codes and response
// bodies are checked, not just service results.

jest.setTimeout(120_000);

const TENANT = TENANT_1_MOCHA_HOUSE_ID;
const PARALLEL = 12;

describe('Admin access changes under concurrency (Security F-2)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const secret = 'f2-concurrency-spec-internal-secret';
  const suffix = randomUUID().slice(0, 8);
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const locationIds: string[] = [];
  let corpRole: string;
  let locRole: string;
  let adminRole: string;

  const token = (key: string) =>
    signInternalDevJwt(
      {
        sub: `internal-dev:f2-${key}-${suffix}`,
        email: `f2-${key}-${suffix}@example.com`,
        name: null,
      },
      secret,
      3600,
    );

  async function user(key: string): Promise<string> {
    const row = await prisma.internalUser.create({
      data: {
        tenantId: TENANT,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:f2-${key}-${suffix}`,
        email: `f2-${key}-${suffix}@example.com`,
        displayName: key,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(row.id);
    return row.id;
  }
  async function role(
    label: string,
    permissionKeys: string[],
  ): Promise<string> {
    const row = await prisma.internalRole.create({
      data: {
        tenantId: TENANT,
        key: `f2-${label}-${suffix}`,
        displayName: `F2 ${label}`,
        permissions: {
          create: permissionKeys.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    roleIds.push(row.id);
    return row.id;
  }
  async function location(label: string): Promise<string> {
    const row = await prisma.location.create({
      data: {
        tenantId: TENANT,
        name: `F2 ${label}`,
        slug: `f2-${label}-${suffix}`,
      },
    });
    locationIds.push(row.id);
    return row.id;
  }
  const grant = (actor: string, target: string, body: object) =>
    request(app.getHttpServer())
      .post(`/api/v1/admin/internal-users/${target}/role-assignments`)
      .set('Authorization', `Bearer ${token(actor)}`)
      .send(body);
  const revoke = (actor: string, target: string, assignmentId: string) =>
    request(app.getHttpServer())
      .post(
        `/api/v1/admin/internal-users/${target}/role-assignments/${assignmentId}/remove`,
      )
      .set('Authorization', `Bearer ${token(actor)}`)
      .send({ reason: 'f2 revoke' });
  const setStatus = (actor: string, target: string, status: string) =>
    request(app.getHttpServer())
      .patch(`/api/v1/admin/internal-users/${target}/status`)
      .set('Authorization', `Bearer ${token(actor)}`)
      .send({ status, reason: 'f2 status' });
  const grantsOf = (target: string) =>
    prisma.internalUserRoleAssignment.findMany({
      where: { internalUserId: target },
      select: { roleId: true, scopeType: true, scopeId: true },
      orderBy: [{ scopeType: 'asc' }, { scopeId: 'asc' }],
    });
  const audits = (target: string, action: string) =>
    prisma.internalAuditEvent.count({
      where: { targetType: 'internal_user', targetId: target, action },
    });
  // A response body may only ever be one of the API's own messages: never
  // a database error, Prisma code, SQL state, constraint or table name.
  const LEAKS =
    /prisma|P20\d\d|serializ|deadlock|constraint|unique|Assignment_|SQL|transaction|40001/i;
  const statuses = (rs: request.Response[]) =>
    rs.map((r) => r.status).sort((x, y) => x - y);
  const adminActors: string[] = [];

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = secret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'f2-concurrency-spec-customer-secret';
    const moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        InternalUsersModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);

    adminRole = (
      await prisma.internalRole.findFirstOrThrow({
        where: { tenantId: TENANT, key: 'platform-administrator' },
      })
    ).id;
    // Several distinct administrators, each a full platform administrator.
    for (let n = 0; n < 4; n += 1) {
      const id = await user(`admin${n}`);
      await prisma.internalUserRoleAssignment.create({
        data: {
          tenantId: TENANT,
          internalUserId: id,
          roleId: adminRole,
          scopeType: 'CORPORATE',
        },
      });
      adminActors.push(`admin${n}`);
    }
    corpRole = await role('corp', ['catalog.products.edit']);
    locRole = await role('loc', ['catalog.overrides.manage']);
  });

  afterAll(async () => {
    try {
      await prisma.internalAuditEvent.deleteMany({
        where: {
          OR: [
            { actorInternalUserId: { in: userIds } },
            { targetId: { in: userIds } },
          ],
        },
      });
      await prisma.internalUserRoleAssignment.deleteMany({
        where: { internalUserId: { in: userIds } },
      });
      await prisma.internalRole.deleteMany({ where: { id: { in: roleIds } } });
      await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
      await prisma.location.deleteMany({ where: { id: { in: locationIds } } });
    } finally {
      await app.close();
      process.env = { ...originalEnv };
    }
  });

  it(`${PARALLEL} simultaneous identical CORPORATE grants: exactly one 201, the rest the ordinary 409, one grant, one audit entry`, async () => {
    const target = await user('corp-target');
    const body = {
      roleId: corpRole,
      scope: { kind: 'corporate' },
      reason: 'f2',
    };
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, (_, n) =>
        grant(adminActors[n % adminActors.length], target, body),
      ),
    );
    expect(statuses(responses)).toEqual([
      201,
      ...Array<number>(PARALLEL - 1).fill(409),
    ]);
    for (const r of responses.filter((x) => x.status === 409)) {
      expect((r.body as { message?: string }).message).toBe(
        'This person already has that access.',
      );
    }
    for (const r of responses)
      expect(JSON.stringify(r.body)).not.toMatch(LEAKS);
    expect(await grantsOf(target)).toEqual([
      { roleId: corpRole, scopeType: 'CORPORATE', scopeId: null },
    ]);
    expect(await audits(target, 'user.role_assigned')).toBe(1);
  });

  it('simultaneous overlapping LOCATION grants: every requested location granted exactly once, every response a normal outcome', async () => {
    const target = await user('loc-target');
    const [l1, l2, l3] = [
      await location('l1'),
      await location('l2'),
      await location('l3'),
    ];
    const bodies = [
      [l1],
      [l1, l2],
      [l2, l3],
      [l1, l2, l3],
      [l3],
      [l1],
      [l2],
      [l1, l3],
    ].map((locationIds) => ({
      roleId: locRole,
      scope: { kind: 'locations', locationIds },
      reason: 'f2',
    }));
    const responses = await Promise.all(
      bodies.map((b, n) =>
        grant(adminActors[n % adminActors.length], target, b),
      ),
    );
    // Each is either a creation (201) or the ordinary duplicate refusal.
    for (const r of responses) {
      expect([201, 409]).toContain(r.status);
      expect(JSON.stringify(r.body)).not.toMatch(LEAKS);
    }
    expect(responses.some((r) => r.status === 201)).toBe(true);
    expect(await grantsOf(target)).toEqual(
      [l1, l2, l3].sort().map((scopeId) => ({
        roleId: locRole,
        scopeType: 'LOCATION',
        scopeId,
      })),
    );
    expect(await audits(target, 'user.role_assigned')).toBe(3);
  });

  it(`${PARALLEL} simultaneous revocations of one grant: exactly one success, the rest the ordinary 404, no grant left behind or half-removed`, async () => {
    const target = await user('revoke-target');
    expect(
      (
        await grant('admin0', target, {
          roleId: corpRole,
          scope: { kind: 'corporate' },
          reason: 'f2',
        })
      ).status,
    ).toBe(201);
    const { id } = await prisma.internalUserRoleAssignment.findFirstOrThrow({
      where: { internalUserId: target },
    });
    const responses = await Promise.all(
      Array.from({ length: PARALLEL }, (_, n) =>
        revoke(adminActors[n % adminActors.length], target, id),
      ),
    );
    expect(statuses(responses)).toEqual([
      201,
      ...Array<number>(PARALLEL - 1).fill(404),
    ]);
    for (const r of responses.filter((x) => x.status === 404)) {
      expect((r.body as { message?: string }).message).toBe(
        'Access assignment not found.',
      );
    }
    for (const r of responses)
      expect(JSON.stringify(r.body)).not.toMatch(LEAKS);
    expect(await grantsOf(target)).toEqual([]);
    expect(await audits(target, 'user.role_removed')).toBe(1);
  });

  it('grant and revoke racing on the same person: the end state is one of the two sequential outcomes, and authorization matches it', async () => {
    const target = await user('race-target');
    expect(
      (
        await grant('admin0', target, {
          roleId: corpRole,
          scope: { kind: 'corporate' },
          reason: 'f2',
        })
      ).status,
    ).toBe(201);
    const { id } = await prisma.internalUserRoleAssignment.findFirstOrThrow({
      where: { internalUserId: target },
    });
    const responses = await Promise.all([
      revoke('admin1', target, id),
      grant('admin2', target, {
        roleId: corpRole,
        scope: { kind: 'corporate' },
        reason: 'f2',
      }),
      grant('admin3', target, {
        roleId: corpRole,
        scope: { kind: 'corporate' },
        reason: 'f2',
      }),
    ]);
    for (const r of responses) {
      expect([201, 404, 409]).toContain(r.status);
      expect(JSON.stringify(r.body)).not.toMatch(LEAKS);
    }
    const rows = await grantsOf(target);
    expect(rows.length).toBeLessThanOrEqual(1);
    // The audit trail explains the end state exactly.
    const assigned = await audits(target, 'user.role_assigned');
    const removed = await audits(target, 'user.role_removed');
    expect(assigned - removed).toBe(rows.length);
  });

  it('two administrators removing each other’s last administrator access at once can never leave the business without an administrator', async () => {
    // A business whose ONLY full administrators are x and y.
    const x = await user('last-x');
    const y = await user('last-y');
    const xs = await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: TENANT,
        internalUserId: x,
        roleId: adminRole,
        scopeType: 'CORPORATE',
      },
    });
    const ys = await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: TENANT,
        internalUserId: y,
        roleId: adminRole,
        scopeType: 'CORPORATE',
      },
    });
    // Everyone else steps aside for this test.
    const others = await prisma.internalUser.findMany({
      where: { tenantId: TENANT, status: 'ACTIVE', id: { notIn: [x, y] } },
      select: { id: true },
    });
    await prisma.internalUser.updateMany({
      where: { id: { in: others.map((o) => o.id) } },
      data: { status: 'SUSPENDED' },
    });
    try {
      const responses = await Promise.all([
        revoke('last-x', y, ys.id),
        revoke('last-y', x, xs.id),
        setStatus('last-x', y, 'SUSPENDED'),
        setStatus('last-y', x, 'SUSPENDED'),
      ]);
      for (const r of responses) {
        expect([200, 201, 404, 409]).toContain(r.status);
        expect(JSON.stringify(r.body)).not.toMatch(LEAKS);
      }
      // At least one of the two is still an ACTIVE full administrator.
      const remaining = await prisma.internalUser.count({
        where: {
          id: { in: [x, y] },
          status: 'ACTIVE',
          roleAssignments: {
            some: { roleId: adminRole, scopeType: 'CORPORATE' },
          },
        },
      });
      expect(remaining).toBeGreaterThanOrEqual(1);
    } finally {
      await prisma.internalUser.updateMany({
        where: { id: { in: others.map((o) => o.id) } },
        data: { status: 'ACTIVE' },
      });
    }
  });

  it('sequential behaviour is unchanged: grant 201, repeat 409, revoke 201, repeat revoke 404, re-grant 201', async () => {
    const target = await user('seq-target');
    const body = {
      roleId: corpRole,
      scope: { kind: 'corporate' },
      reason: 'f2',
    };
    expect((await grant('admin0', target, body)).status).toBe(201);
    const dup = await grant('admin0', target, body);
    expect([dup.status, (dup.body as { message?: string }).message]).toEqual([
      409,
      'This person already has that access.',
    ]);
    const { id } = await prisma.internalUserRoleAssignment.findFirstOrThrow({
      where: { internalUserId: target },
    });
    expect((await revoke('admin0', target, id)).status).toBe(201);
    expect((await revoke('admin0', target, id)).status).toBe(404);
    expect((await grant('admin0', target, body)).status).toBe(201);
  });
});
