import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminAccessAssignmentOptions,
  AdminInternalUserDetail,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { InternalUsersModule } from './internal-users.module';
import { InternalAuditService } from '../audit/internal-audit.service';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';

type Status = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

// Administration -> access level + location assignment (Milestone 5E-4):
// the audited grant / remove writes, over real local Postgres. The spec
// suspends the seeded platform admin in beforeAll (restored in afterAll) so
// the protected-administrator population is exactly the fixtures here.
describe('Admin internal user access assignment (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'admin-user-access-spec-internal-secret';
  const customerSecret = 'admin-user-access-spec-customer-secret';
  const suffix = randomUUID();

  let locA: string;
  let locB: string;
  let locInactive: string;
  let platformAdminRoleId: string;
  let storeManagerRoleId: string;

  let seededAdminId: string | null = null;
  let seededAdminOriginalStatus: Status = 'ACTIVE';
  const userIds: string[] = [];
  const roleIds: string[] = [];

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
        key: `access-spec-${suffix}-${randomUUID()}`,
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

  async function detail(userId: string): Promise<AdminInternalUserDetail> {
    // Read as the full actor.
    const res = await request(app.getHttpServer())
      .get(`/api/v1/admin/internal-users/${userId}`)
      .set('Authorization', `Bearer ${token(`fullActor-${suffix}`)}`)
      .expect(200);
    return res.body as AdminInternalUserDetail;
  }

  // Disable a user so a later "no other independent administrator exists"
  // assertion is not polluted by an ACTIVE protected admin an earlier test
  // created. Tests run --runInBand in file order.
  async function retire(id: string) {
    await prisma.internalUser.update({
      where: { id },
      data: { status: 'DISABLED' },
    });
  }

  async function auditFor(targetId: string) {
    return prisma.internalAuditEvent.findMany({
      where: { targetType: 'internal_user', targetId },
      orderBy: { createdAt: 'asc' },
    });
  }

  const assignRole = (actorKey: string, targetId: string, body: unknown) =>
    request(app.getHttpServer())
      .post(`/api/v1/admin/internal-users/${targetId}/role-assignments`)
      .set('Authorization', `Bearer ${token(actorKey)}`)
      .send(body as object);

  const removeAssignment = (
    actorKey: string,
    targetId: string,
    assignmentId: string,
    body: unknown,
  ) =>
    request(app.getHttpServer())
      .post(
        `/api/v1/admin/internal-users/${targetId}/role-assignments/${assignmentId}/remove`,
      )
      .set('Authorization', `Bearer ${token(actorKey)}`)
      .send(body as object);

  const optionsAs = (actorKey: string) =>
    request(app.getHttpServer())
      .get('/api/v1/admin/internal-users/access-options')
      .set('Authorization', `Bearer ${token(actorKey)}`);

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
        InternalUsersModule,
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const seeded = await prisma.internalUser.findUnique({
      where: { email: 'admin@mochahouse.test' },
      select: { id: true, status: true },
    });
    if (seeded) {
      seededAdminId = seeded.id;
      seededAdminOriginalStatus = seeded.status;
      await prisma.internalUser.update({
        where: { id: seeded.id },
        data: { status: 'SUSPENDED' },
      });
    }

    // The seeded built-in access levels are the ones the assignment picker
    // uses; the assign endpoint accepts any role id.
    platformAdminRoleId = (
      await prisma.internalRole.findUniqueOrThrow({
        where: { key: 'platform-administrator' },
      })
    ).id;
    storeManagerRoleId = (
      await prisma.internalRole.findUniqueOrThrow({
        where: { key: 'store-manager' },
      })
    ).id;

    locA = (
      await prisma.location.create({
        data: {
          name: `Access Spec Loc A ${suffix}`,
          slug: `access-a-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;
    locB = (
      await prisma.location.create({
        data: {
          name: `Access Spec Loc B ${suffix}`,
          slug: `access-b-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;
    locInactive = (
      await prisma.location.create({
        data: {
          name: `Access Spec Loc Inactive ${suffix}`,
          slug: `access-x-${suffix}`,
          isActive: false,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;

    roles.assigner = await makeRole('Access Assigner', ['users.manage_roles']);
    // Mirrors the built-in Store Manager permission set exactly, so the
    // privilege-ceiling cases below (this actor granting Store Manager) test
    // scope, not a missing capability.
    roles.storeOps = await makeRole('Store Ops', [
      'locations.view',
      'orders.view',
      'orders.manage_status',
      'catalog.overrides.manage',
      'locations.manage_digital_ordering',
      'operations.view',
    ]);
    roles.usersView = await makeRole('Users View', ['users.view']);
    roles.unknownKey = await makeRole('Legacy Role', [
      'orders.view',
      'defunct.made.up.key',
    ]);
    roles.ambiguous = await makeRole('Mixed Role', [
      'catalog.view',
      'orders.view',
    ]);

    // Actors.
    await makeUser(`fullActor-${suffix}`, 'ACTIVE');
    await assign(userIds.at(-1)!, platformAdminRoleId, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await makeUser(`assignerActor-${suffix}`, 'ACTIVE');
    await assign(userIds.at(-1)!, roles.assigner, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await makeUser(`partialActor-${suffix}`, 'ACTIVE');
    await assign(userIds.at(-1)!, roles.assigner, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await assign(userIds.at(-1)!, roles.storeOps, {
      scopeType: 'LOCATION',
      scopeId: locA,
    });

    await makeUser(`viewerActor-${suffix}`, 'ACTIVE');
    await assign(userIds.at(-1)!, roles.usersView, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await makeUser(`locAssignerActor-${suffix}`, 'ACTIVE');
    await assign(userIds.at(-1)!, roles.assigner, {
      scopeType: 'LOCATION',
      scopeId: locA,
    });
  }, 45_000);

  afterAll(async () => {
    await prisma.internalAuditEvent.deleteMany({
      where: {
        OR: [
          { actorInternalUserId: { in: userIds } },
          { targetType: 'internal_user', targetId: { in: userIds } },
        ],
      },
    });
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    for (const id of roleIds) {
      await prisma.internalRolePermission.deleteMany({ where: { roleId: id } });
      await prisma.internalRole.deleteMany({ where: { id } });
    }
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.location.deleteMany({
      where: { id: { in: [locA, locB, locInactive] } },
    });
    if (seededAdminId) {
      await prisma.internalUser.update({
        where: { id: seededAdminId },
        data: { status: seededAdminOriginalStatus },
      });
    }
    await app.close();
    process.env = { ...originalEnv };
  });

  // ---- Authorization (1-5) ---------------------------------------

  it('a customer token is rejected (401) on every 5E-4 route', async () => {
    const t = await makeUser(`auth-cust-${suffix}`, 'ACTIVE');
    await request(app.getHttpServer())
      .get('/api/v1/admin/internal-users/access-options')
      .set('Authorization', `Bearer ${customerToken()}`)
      .expect(401);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/internal-users/${t}/role-assignments`)
      .set('Authorization', `Bearer ${customerToken()}`)
      .send({
        roleId: storeManagerRoleId,
        scope: { kind: 'locations', locationIds: [locA] },
        reason: 'x',
      })
      .expect(401);
  });

  it('a user without users.manage_roles is denied (403) on options / assign / remove', async () => {
    const t = await makeUser(`auth-noperm-${suffix}`, 'ACTIVE');
    await optionsAs(`viewerActor-${suffix}`).expect(403);
    await assignRole(`viewerActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'x',
    }).expect(403);
    await removeAssignment(`viewerActor-${suffix}`, t, randomUUID(), {
      reason: 'x',
    }).expect(403);
  });

  it('a LOCATION-scoped users.manage_roles grant cannot satisfy the CORPORATE-only route (403)', async () => {
    const t = await makeUser(`auth-loc-${suffix}`, 'ACTIVE');
    await optionsAs(`locAssignerActor-${suffix}`).expect(403);
    await assignRole(`locAssignerActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'x',
    }).expect(403);
  });

  it('holding users.manage_roles is sufficient for the picker — roles.view is not also required', async () => {
    await optionsAs(`assignerActor-${suffix}`).expect(200);
  });

  it('a SUSPENDED actor is rejected (403)', async () => {
    const t = await makeUser(`auth-susp-${suffix}`, 'ACTIVE');
    const suspended = `susp-actor-${suffix}`;
    await makeUser(suspended, 'SUSPENDED');
    await assign(userIds.at(-1)!, platformAdminRoleId, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await assignRole(suspended, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'x',
    }).expect(403);
  });

  // ---- Store Manager seed (6-11) --------------------------------

  it('the seed creates store-manager with exactly the approved permission set', async () => {
    const role = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'store-manager' },
      include: { permissions: true },
    });
    expect(role.displayName).toBe('Store Manager');
    expect(role.isSystem).toBe(true);
    expect(role.description).toBe(
      'Manages day-to-day orders, online ordering, prices and availability for assigned locations.',
    );
    expect(role.permissions.map((p) => p.permissionKey).sort()).toEqual(
      [
        'catalog.overrides.manage',
        'locations.manage_digital_ordering',
        'locations.view',
        'operations.view',
        'orders.manage_status',
        'orders.view',
      ].sort(),
    );
  });

  it('store-manager is not assigned to anyone by the seed', async () => {
    const count = await prisma.internalUserRoleAssignment.count({
      where: { role: { key: 'store-manager' } },
    });
    // Only assignments this spec itself creates may exist; the seed adds none.
    const specAssigned = await prisma.internalUserRoleAssignment.count({
      where: {
        role: { key: 'store-manager' },
        internalUserId: { in: userIds },
      },
    });
    expect(count).toBe(specAssigned);
  });

  it('platform-administrator still holds every permission including users.manage_roles', async () => {
    const role = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'platform-administrator' },
      include: { permissions: true },
    });
    const keys = role.permissions.map((p) => p.permissionKey);
    expect(keys).toContain('users.manage_roles');
    expect(keys).toContain('users.manage_status');
  });

  // ---- Options (12-15) -----------------------------------------

  it('the picker returns the two built-in access levels with the right assignment shapes', async () => {
    const res = await optionsAs(`fullActor-${suffix}`).expect(200);
    const body = res.body as AdminAccessAssignmentOptions;
    const byName = new Map(body.accessLevels.map((l) => [l.displayName, l]));
    expect(byName.get('Platform Administrator')?.assignmentShape).toBe(
      'corporate-only',
    );
    expect(byName.get('Store Manager')?.assignmentShape).toBe('location-only');
    expect(byName.get('Store Manager')?.isBuiltIn).toBe(true);
  });

  it('the picker never leaks permission keys or a role key', async () => {
    const res = await optionsAs(`fullActor-${suffix}`).expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(
      /"key"|permissionKey|orders\.view|users\.manage_roles/,
    );
  });

  it('the picker lists only ACTIVE locations', async () => {
    const res = await optionsAs(`fullActor-${suffix}`).expect(200);
    const body = res.body as AdminAccessAssignmentOptions;
    const ids = body.locations.map((l) => l.id);
    expect(ids).toContain(locA);
    expect(ids).toContain(locB);
    expect(ids).not.toContain(locInactive);
  });

  it('each access level carries a plain-language capability summary', async () => {
    const res = await optionsAs(`fullActor-${suffix}`).expect(200);
    const body = res.body as AdminAccessAssignmentOptions;
    const storeManager = body.accessLevels.find(
      (l) => l.displayName === 'Store Manager',
    );
    const lines = storeManager?.capabilities.flatMap((g) => g.items) ?? [];
    expect(lines).toContain('View orders');
    expect(lines).toContain('Set location prices and availability');
  });

  // ---- Assign (16-34) -----------------------------------------

  it('grants Store Manager at one location and returns the refreshed detail', async () => {
    const t = await makeUser(`assign-one-${suffix}`, 'ACTIVE');
    const res = await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'runs the store',
    }).expect(201);
    const body = res.body as AdminInternalUserDetail;
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0].accessLevel.displayName).toBe('Store Manager');
    expect(body.assignments[0].isCorporate).toBe(false);
    expect(body.assignments[0].location?.id).toBe(locA);
  });

  it('grants Store Manager at several locations in one request — one assignment per location', async () => {
    const t = await makeUser(`assign-multi-${suffix}`, 'ACTIVE');
    const res = await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA, locB] },
      reason: 'covers two stores',
    }).expect(201);
    const body = res.body as AdminInternalUserDetail;
    const storeManagerAssignments = body.assignments.filter(
      (a) => a.accessLevel.displayName === 'Store Manager',
    );
    expect(storeManagerAssignments.map((a) => a.location?.id).sort()).toEqual(
      [locA, locB].sort(),
    );
  });

  it('grants Platform Administrator at corporate scope', async () => {
    const t = await makeUser(`assign-corp-${suffix}`, 'ACTIVE');
    const res = await assignRole(`fullActor-${suffix}`, t, {
      roleId: platformAdminRoleId,
      scope: { kind: 'corporate' },
      reason: 'promoted to platform admin',
    }).expect(201);
    const body = res.body as AdminInternalUserDetail;
    expect(body.assignments).toHaveLength(1);
    expect(body.assignments[0].isCorporate).toBe(true);
    expect(body.assignments[0].location).toBeNull();
    await retire(t);
  });

  it('rejects assigning Platform Administrator at location scope (400)', async () => {
    const t = await makeUser(`assign-corp-bad-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: platformAdminRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'x',
    }).expect(400);
  });

  it('rejects assigning Store Manager at corporate scope (400)', async () => {
    const t = await makeUser(`assign-loc-bad-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'corporate' },
      reason: 'x',
    }).expect(400);
  });

  it('rejects an empty / missing location list for a location-only level (400)', async () => {
    const t = await makeUser(`assign-noloc-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [] },
      reason: 'x',
    }).expect(400);
  });

  it('de-duplicates repeated location ids in one request', async () => {
    const t = await makeUser(`assign-dupe-${suffix}`, 'ACTIVE');
    const res = await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA, locA] },
      reason: 'x',
    }).expect(201);
    const body = res.body as AdminInternalUserDetail;
    expect(body.assignments).toHaveLength(1);
  });

  it('rejects an unknown location (400) and an inactive location (400)', async () => {
    const t = await makeUser(`assign-badloc-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [randomUUID()] },
      reason: 'x',
    }).expect(400);
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locInactive] },
      reason: 'x',
    }).expect(400);
  });

  it('a blank / missing reason is rejected (400)', async () => {
    const t = await makeUser(`assign-reason-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: '   ',
    }).expect(400);
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
    }).expect(400);
  });

  it('an unknown role id => 404, an unknown target => 404', async () => {
    const t = await makeUser(`assign-404-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: randomUUID(),
      scope: { kind: 'corporate' },
      reason: 'x',
    }).expect(404);
    await assignRole(`fullActor-${suffix}`, randomUUID(), {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'x',
    }).expect(404);
  });

  it('an actor cannot change their own access (403)', async () => {
    const actorRow = await prisma.internalUser.findUniqueOrThrow({
      where: { email: `fullActor-${suffix}@example.com` },
    });
    await assignRole(`fullActor-${suffix}`, actorRow.id, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'self',
    }).expect(403);
  });

  it('a role with an unrecognised stored permission key fails closed (409)', async () => {
    const t = await makeUser(`assign-unknown-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: roles.unknownKey,
      scope: { kind: 'corporate' },
      reason: 'x',
    }).expect(409);
  });

  it('a role whose permissions do not agree on a shape cannot be assigned (409)', async () => {
    const t = await makeUser(`assign-ambig-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: roles.ambiguous,
      scope: { kind: 'corporate' },
      reason: 'x',
    }).expect(409);
  });

  it('privilege ceiling: an actor holding only users.manage_roles cannot grant Store Manager anywhere (403)', async () => {
    const t = await makeUser(`ceiling-none-${suffix}`, 'ACTIVE');
    await assignRole(`assignerActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'x',
    }).expect(403);
  });

  it('privilege ceiling: an actor holding Store Ops only at locA may grant Store Manager at locA but not locB', async () => {
    const t = await makeUser(`ceiling-partial-${suffix}`, 'ACTIVE');
    await assignRole(`partialActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locB] },
      reason: 'x',
    }).expect(403);
    await assignRole(`partialActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'x',
    }).expect(201);
  });

  it('privilege ceiling: only a full corporate holder may grant Platform Administrator (403 for a partial actor)', async () => {
    const t = await makeUser(`ceiling-corp-${suffix}`, 'ACTIVE');
    await assignRole(`assignerActor-${suffix}`, t, {
      roleId: platformAdminRoleId,
      scope: { kind: 'corporate' },
      reason: 'x',
    }).expect(403);
  });

  it('an exact duplicate grant is a clear conflict (409); a mix creates only the missing rows', async () => {
    const t = await makeUser(`assign-conflict-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'first',
    }).expect(201);
    // Exact duplicate.
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'again',
    }).expect(409);
    // Mixed: locA already present, locB new -> only locB is created.
    const res = await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA, locB] },
      reason: 'extend',
    }).expect(201);
    const body = res.body as AdminInternalUserDetail;
    const locs = body.assignments
      .filter((a) => a.accessLevel.displayName === 'Store Manager')
      .map((a) => a.location?.id)
      .sort();
    expect(locs).toEqual([locA, locB].sort());
    const events = await auditFor(t);
    // 1 (first) + 0 (duplicate rejected) + 1 (only locB) = 2.
    expect(
      events.filter((e) => e.action === 'user.role_assigned'),
    ).toHaveLength(2);
  });

  it('the grant takes effect on the target’s next request without re-login', async () => {
    const key = `assign-effect-${suffix}`;
    const t = await makeUser(key, 'ACTIVE');
    await request(app.getHttpServer())
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${token(key)}`)
      .expect(200)
      .expect((r) => expect(r.body.authorization.permissions).toEqual([]));
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'x',
    }).expect(201);
    await request(app.getHttpServer())
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${token(key)}`)
      .expect(200)
      .expect((r) => {
        expect(r.body.authorization.permissions).toContain('orders.view');
        expect(
          r.body.authorization.capabilities['orders.view'].locationIds,
        ).toEqual([locA]);
      });
  });

  it('the frontend cannot smuggle raw tuples — an unexpected scope shape is a 400', async () => {
    const t = await makeUser(`assign-smuggle-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { scopeType: 'LOCATION', scopeId: locA },
      reason: 'x',
    }).expect(400);
  });

  // ---- Remove (35-41) ----------------------------------------

  it('removes one location’s grant without touching the person’s other locations', async () => {
    const t = await makeUser(`remove-one-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA, locB] },
      reason: 'both',
    }).expect(201);
    const before = await detail(t);
    const locAAssignment = before.assignments.find(
      (a) => a.location?.id === locA,
    )!;
    const res = await removeAssignment(
      `fullActor-${suffix}`,
      t,
      locAAssignment.id,
      { reason: 'left that store' },
    ).expect(201);
    const body = res.body as AdminInternalUserDetail;
    expect(body.assignments.map((a) => a.location?.id)).toEqual([locB]);
  });

  it('an assignment id that belongs to a different user => 404', async () => {
    const owner = await makeUser(`remove-owner-${suffix}`, 'ACTIVE');
    const other = await makeUser(`remove-other-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, owner, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'x',
    }).expect(201);
    const ownerDetail = await detail(owner);
    await removeAssignment(
      `fullActor-${suffix}`,
      other,
      ownerDetail.assignments[0].id,
      { reason: 'x' },
    ).expect(404);
  });

  it('an unknown assignment id => 404', async () => {
    const t = await makeUser(`remove-404-${suffix}`, 'ACTIVE');
    await removeAssignment(`fullActor-${suffix}`, t, randomUUID(), {
      reason: 'x',
    }).expect(404);
  });

  it('a blank reason on removal is rejected (400)', async () => {
    const t = await makeUser(`remove-reason-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'x',
    }).expect(201);
    const d = await detail(t);
    await removeAssignment(`fullActor-${suffix}`, t, d.assignments[0].id, {
      reason: '  ',
    }).expect(400);
  });

  it('an actor cannot remove their own access (403)', async () => {
    const actorRow = await prisma.internalUser.findUniqueOrThrow({
      where: { email: `fullActor-${suffix}@example.com` },
    });
    const d = await detail(actorRow.id);
    await removeAssignment(
      `fullActor-${suffix}`,
      actorRow.id,
      d.assignments[0]?.id ?? randomUUID(),
      { reason: 'self' },
    ).expect(403);
  });

  it('removing a Store Manager location grant is never gated by the administrator rule', async () => {
    const t = await makeUser(`remove-storemgr-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'x',
    }).expect(201);
    const d = await detail(t);
    await removeAssignment(`fullActor-${suffix}`, t, d.assignments[0].id, {
      reason: 'reorg',
    }).expect(201);
  });

  // ---- Audit (42-53) ----------------------------------------

  it('a grant writes exactly one user.role_assigned event per created row, with location + role snapshots', async () => {
    const t = await makeUser(`audit-assign-${suffix}`, 'ACTIVE');
    const actorRow = await prisma.internalUser.findUniqueOrThrow({
      where: { email: `fullActor-${suffix}@example.com` },
    });
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: '  covers the store  ',
    }).expect(201);
    const events = await auditFor(t);
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event.action).toBe('user.role_assigned');
    expect(event.actorInternalUserId).toBe(actorRow.id);
    expect(event.targetId).toBe(t);
    expect(event.reason).toBe('covers the store');
    expect(event.beforeData).toEqual({ assignment: null });
    expect(event.afterData).toEqual({
      assignment: {
        roleId: storeManagerRoleId,
        roleDisplayName: 'Store Manager',
        scope: 'LOCATION',
        locationId: locA,
        locationName: `Access Spec Loc A ${suffix}`,
      },
    });
  });

  it('a corporate grant records scope CORPORATE and no location', async () => {
    const t = await makeUser(`audit-corp-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: platformAdminRoleId,
      scope: { kind: 'corporate' },
      reason: 'x',
    }).expect(201);
    const events = await auditFor(t);
    expect(events[0].afterData).toEqual({
      assignment: {
        roleId: platformAdminRoleId,
        roleDisplayName: 'Platform Administrator',
        scope: 'CORPORATE',
      },
    });
    await retire(t);
  });

  it('a removal writes a mirror-image user.role_removed event', async () => {
    const t = await makeUser(`audit-remove-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locB] },
      reason: 'x',
    }).expect(201);
    const d = await detail(t);
    await removeAssignment(`fullActor-${suffix}`, t, d.assignments[0].id, {
      reason: 'done',
    }).expect(201);
    const events = await auditFor(t);
    const removed = events.find((e) => e.action === 'user.role_removed')!;
    expect(removed.afterData).toEqual({ assignment: null });
    expect(removed.beforeData).toEqual({
      assignment: {
        roleId: storeManagerRoleId,
        roleDisplayName: 'Store Manager',
        scope: 'LOCATION',
        locationId: locB,
        locationName: `Access Spec Loc B ${suffix}`,
      },
    });
  });

  it('a rejected grant writes NO audit event', async () => {
    const t = await makeUser(`audit-none-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'corporate' },
      reason: 'x',
    }).expect(400);
    expect(await auditFor(t)).toHaveLength(0);
  });

  it('if the audit write fails, the assignment insert rolls back too', async () => {
    const t = await makeUser(`audit-atomic-${suffix}`, 'ACTIVE');
    const auditService = app.get(InternalAuditService);
    const spy = jest
      .spyOn(auditService, 'recordRoleAssigned')
      .mockRejectedValueOnce(new Error('simulated audit failure'));
    try {
      const res = await assignRole(`fullActor-${suffix}`, t, {
        roleId: storeManagerRoleId,
        scope: { kind: 'locations', locationIds: [locA] },
        reason: 'should not stick',
      });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      spy.mockRestore();
    }
    const d = await detail(t);
    expect(d.assignments).toHaveLength(0);
    expect(await auditFor(t)).toHaveLength(0);
  });

  it('if the audit write fails on removal, the delete rolls back too', async () => {
    const t = await makeUser(`audit-atomic-rm-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'x',
    }).expect(201);
    const d = await detail(t);
    const auditService = app.get(InternalAuditService);
    const spy = jest
      .spyOn(auditService, 'recordRoleRemoved')
      .mockRejectedValueOnce(new Error('simulated audit failure'));
    try {
      const res = await removeAssignment(
        `fullActor-${suffix}`,
        t,
        d.assignments[0].id,
        { reason: 'x' },
      );
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      spy.mockRestore();
    }
    const after = await detail(t);
    expect(after.assignments).toHaveLength(1);
  });

  // ---- Protected administrator (54-59) ---------------------

  it('the last independent corporate administrator’s Platform Administrator grant cannot be removed', async () => {
    // fullActor + this target are the only protected admins; actor is
    // excluded from the "independent" count, so removal is rejected.
    const target = await makeUser(`prot-sole-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, target, {
      roleId: platformAdminRoleId,
      scope: { kind: 'corporate' },
      reason: 'x',
    }).expect(201);
    const d = await detail(target);
    const res = await removeAssignment(
      `fullActor-${suffix}`,
      target,
      d.assignments[0].id,
      { reason: 'demote' },
    );
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/other active Platform Administrator/i);
    // Untouched.
    expect((await detail(target)).assignments).toHaveLength(1);
    await retire(target);
  });

  it('removal succeeds when another independent protected administrator remains', async () => {
    const target = await makeUser(`prot-ok-t-${suffix}`, 'ACTIVE');
    const independent = await makeUser(`prot-ok-i-${suffix}`, 'ACTIVE');
    for (const id of [target, independent]) {
      await assignRole(`fullActor-${suffix}`, id, {
        roleId: platformAdminRoleId,
        scope: { kind: 'corporate' },
        reason: 'x',
      }).expect(201);
    }
    const d = await detail(target);
    await removeAssignment(`fullActor-${suffix}`, target, d.assignments[0].id, {
      reason: 'ok',
    }).expect(201);
    // Clean up the independent admin so later tests are not polluted.
    await prisma.internalUser.update({
      where: { id: independent },
      data: { status: 'DISABLED' },
    });
  });

  it('a Store Manager grant never counts toward the protected-administrator rule', async () => {
    const target = await makeUser(`prot-sm-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, target, {
      roleId: platformAdminRoleId,
      scope: { kind: 'corporate' },
      reason: 'x',
    }).expect(201);
    await assignRole(`fullActor-${suffix}`, target, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'x',
    }).expect(201);
    const d = await detail(target);
    const smAssignment = d.assignments.find(
      (a) => a.accessLevel.displayName === 'Store Manager',
    )!;
    // Removing the Store Manager grant is fine even though the target is the
    // last independent admin — it is not the protected capability.
    await removeAssignment(`fullActor-${suffix}`, target, smAssignment.id, {
      reason: 'x',
    }).expect(201);
    await retire(target);
  });

  // ---- Regression (60-63) --------------------------------

  it('5E-3 status protection still holds under the shared protected-admin definition', async () => {
    const target = await makeUser(`reg-status-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, target, {
      roleId: platformAdminRoleId,
      scope: { kind: 'corporate' },
      reason: 'x',
    }).expect(201);
    await request(app.getHttpServer())
      .patch(`/api/v1/admin/internal-users/${target}/status`)
      .set('Authorization', `Bearer ${token(`fullActor-${suffix}`)}`)
      .send({ status: 'SUSPENDED', reason: 'x' })
      .expect(409);
    await retire(target);
  });

  it('assignment is decoupled from status — a SUSPENDED user keeps their assignments', async () => {
    const t = await makeUser(`reg-suspended-${suffix}`, 'ACTIVE');
    await assignRole(`fullActor-${suffix}`, t, {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
      reason: 'x',
    }).expect(201);
    await prisma.internalUser.update({
      where: { id: t },
      data: { status: 'SUSPENDED' },
    });
    const d = await detail(t);
    expect(d.assignments).toHaveLength(1);
  });
});
