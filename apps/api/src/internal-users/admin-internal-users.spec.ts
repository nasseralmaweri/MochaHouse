import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminInternalUserDetail,
  AdminInternalUserSummary,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { InternalUsersModule } from './internal-users.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';

// Administration → Users read (Milestone 5E-1), end to end over real local
// Postgres: authorization matrix + the access / location / capability
// resolution.
describe('Admin internal users read (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'admin-users-spec-internal-secret';
  const customerSecret = 'admin-users-spec-customer-secret';
  const suffix = randomUUID();

  let locA: string;
  let locB: string;
  const userIds: Record<string, string> = {};
  const roleIds: string[] = [];

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

  async function createUser(
    key: string,
    status: 'ACTIVE' | 'INVITED' | 'SUSPENDED' | 'DISABLED',
    displayName: string | null,
  ): Promise<string> {
    const user = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${key}`,
        email: `${key}@example.com`,
        displayName,
        status,
        activatedAt: status === 'ACTIVE' ? new Date() : null,
      },
    });
    userIds[key] = user.id;
    return user.id;
  }

  async function createRole(
    displayName: string,
    permissionKeys: string[],
  ): Promise<string> {
    const role = await prisma.internalRole.create({
      data: {
        key: `admin-users-${suffix}-${randomUUID()}`,
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

    locA = (
      await prisma.location.create({
        data: {
          name: `Users Spec Aardvark ${suffix}`,
          slug: `users-a-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;
    locB = (
      await prisma.location.create({
        data: {
          name: `Users Spec Beluga ${suffix}`,
          slug: `users-b-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;

    // --- Callers (authenticate against these) --------------------------
    const usersViewCorp = await createRole('Access Review Corp', [
      'users.view',
    ]);
    const usersViewLoc = await createRole('Access Review Loc', ['users.view']);
    const ordersOnly = await createRole('Orders Only', ['orders.view']);

    await createUser(`corpViewer-${suffix}`, 'ACTIVE', 'Corp Viewer');
    await assign(userIds[`corpViewer-${suffix}`], usersViewCorp, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await createUser(`locViewer-${suffix}`, 'ACTIVE', 'Loc Viewer');
    await assign(userIds[`locViewer-${suffix}`], usersViewLoc, {
      scopeType: 'LOCATION',
      scopeId: locA,
    });

    await createUser(`noPerm-${suffix}`, 'ACTIVE', 'No Perm');
    await assign(userIds[`noPerm-${suffix}`], ordersOnly, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await createUser(`suspendedViewer-${suffix}`, 'SUSPENDED', 'Susp Viewer');
    await assign(userIds[`suspendedViewer-${suffix}`], usersViewCorp, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await createUser(`disabledViewer-${suffix}`, 'DISABLED', 'Dis Viewer');
    await assign(userIds[`disabledViewer-${suffix}`], usersViewCorp, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    // --- Target data users (read about, never authenticate) ------------
    // Corporate operator — capabilities must read "all locations".
    const corpOps = await createRole('Corporate Operations', [
      'orders.view',
      'orders.manage_status',
      'catalog.overrides.manage',
    ]);
    await createUser(`corpTarget-${suffix}`, 'ACTIVE', 'Corp Target');
    await assign(userIds[`corpTarget-${suffix}`], corpOps, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    // One role, two locations.
    const storeTeam = await createRole('Store Team', [
      'orders.view',
      'orders.manage_status',
    ]);
    await createUser(`multiLoc-${suffix}`, 'ACTIVE', 'Multi Loc');
    await assign(userIds[`multiLoc-${suffix}`], storeTeam, {
      scopeType: 'LOCATION',
      scopeId: locA,
    });
    await assign(userIds[`multiLoc-${suffix}`], storeTeam, {
      scopeType: 'LOCATION',
      scopeId: locB,
    });

    // Two different roles at two different locations.
    const alpha = await createRole('Alpha Access', ['orders.view']);
    const bravo = await createRole('Bravo Access', [
      'catalog.overrides.manage',
    ]);
    await createUser(`multiRole-${suffix}`, 'ACTIVE', 'Multi Role');
    await assign(userIds[`multiRole-${suffix}`], alpha, {
      scopeType: 'LOCATION',
      scopeId: locA,
    });
    await assign(userIds[`multiRole-${suffix}`], bravo, {
      scopeType: 'LOCATION',
      scopeId: locB,
    });

    // A misleadingly-named role that grants almost nothing.
    const misleading = await createRole('Full System Administrator', [
      'orders.view',
    ]);
    await createUser(`misleading-${suffix}`, 'ACTIVE', 'Misleading Name');
    await assign(userIds[`misleading-${suffix}`], misleading, {
      scopeType: 'LOCATION',
      scopeId: locA,
    });

    // A role carrying an unknown/legacy permission key alongside a real one.
    const legacy = await createRole('Legacy Role', [
      'orders.view',
      'totally.made.up.key',
    ]);
    await createUser(`unknownKey-${suffix}`, 'ACTIVE', 'Unknown Key');
    await assign(userIds[`unknownKey-${suffix}`], legacy, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await createUser(`invited-${suffix}`, 'INVITED', 'Invited Person');
    await createUser(`suspendedTarget-${suffix}`, 'SUSPENDED', 'Susp Target');
    await assign(userIds[`suspendedTarget-${suffix}`], ordersOnly, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await createUser(`disabledTarget-${suffix}`, 'DISABLED', 'Dis Target');
    await createUser(`noAccess-${suffix}`, 'ACTIVE', 'No Access');
  }, 30_000);

  afterAll(async () => {
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: Object.values(userIds) } },
    });
    for (const id of roleIds) {
      await prisma.internalRolePermission.deleteMany({ where: { roleId: id } });
      await prisma.internalRole.deleteMany({ where: { id } });
    }
    await prisma.internalUser.deleteMany({
      where: { id: { in: Object.values(userIds) } },
    });
    await prisma.location.deleteMany({ where: { id: { in: [locA, locB] } } });
    await app.close();
    process.env = { ...originalEnv };
  });

  const http = () => request(app.getHttpServer());
  const listAs = (key: string) =>
    http().get('/api/v1/admin/internal-users').set('Authorization', `Bearer ${token(key)}`);
  const detailAs = (key: string, id: string) =>
    http()
      .get(`/api/v1/admin/internal-users/${id}`)
      .set('Authorization', `Bearer ${token(key)}`);

  // ---- Permission / authentication ----------------------------------

  it('CORPORATE users.view can list users (200)', async () => {
    await listAs(`corpViewer-${suffix}`).expect(200);
  });

  it('CORPORATE users.view can open a user detail (200)', async () => {
    await detailAs(
      `corpViewer-${suffix}`,
      userIds[`corpTarget-${suffix}`],
    ).expect(200);
  });

  it('a user without users.view is denied (403) on list and detail', async () => {
    await listAs(`noPerm-${suffix}`).expect(403);
    await detailAs(`noPerm-${suffix}`, userIds[`corpTarget-${suffix}`]).expect(
      403,
    );
  });

  it('a LOCATION-scoped users.view grant cannot satisfy the CORPORATE-only route (403)', async () => {
    await listAs(`locViewer-${suffix}`).expect(403);
    await detailAs(
      `locViewer-${suffix}`,
      userIds[`corpTarget-${suffix}`],
    ).expect(403);
  });

  it('a customer token is rejected (401)', async () => {
    await http()
      .get('/api/v1/admin/internal-users')
      .set('Authorization', `Bearer ${customerToken()}`)
      .expect(401);
  });

  it('a SUSPENDED internal user is denied (403) even with a corporate users.view role', async () => {
    await listAs(`suspendedViewer-${suffix}`).expect(403);
  });

  it('a DISABLED internal user is denied (403) even with a corporate users.view role', async () => {
    await listAs(`disabledViewer-${suffix}`).expect(403);
  });

  // ---- Data behavior ------------------------------------------------

  it('the list includes users of every status', async () => {
    const res = await listAs(`corpViewer-${suffix}`).expect(200);
    const body = res.body as AdminInternalUserSummary[];
    const byId = new Map(body.map((u) => [u.id, u]));
    expect(byId.get(userIds[`corpTarget-${suffix}`])?.status).toBe('ACTIVE');
    expect(byId.get(userIds[`invited-${suffix}`])?.status).toBe('INVITED');
    expect(byId.get(userIds[`suspendedTarget-${suffix}`])?.status).toBe(
      'SUSPENDED',
    );
    expect(byId.get(userIds[`disabledTarget-${suffix}`])?.status).toBe(
      'DISABLED',
    );
  });

  it('the list is ordered by display name then email then id', async () => {
    const res = await listAs(`corpViewer-${suffix}`).expect(200);
    const body = res.body as AdminInternalUserSummary[];
    const key = (u: AdminInternalUserSummary) =>
      (u.displayName ?? u.email).toLowerCase();
    const sorted = [...body].sort(
      (a, b) =>
        key(a).localeCompare(key(b)) ||
        a.email.toLowerCase().localeCompare(b.email.toLowerCase()) ||
        a.id.localeCompare(b.id),
    );
    expect(body).toEqual(sorted);
  });

  it('a corporate assignment is represented as "all locations"', async () => {
    const res = await detailAs(
      `corpViewer-${suffix}`,
      userIds[`corpTarget-${suffix}`],
    ).expect(200);
    const body = res.body as AdminInternalUserDetail;
    expect(body.locationAccess).toEqual({ kind: 'all' });
    expect(body.accessLevels).toEqual(['Corporate Operations']);
  });

  it('one role across two locations => one access level, both locations', async () => {
    const res = await detailAs(
      `corpViewer-${suffix}`,
      userIds[`multiLoc-${suffix}`],
    ).expect(200);
    const body = res.body as AdminInternalUserDetail;
    expect(body.accessLevels).toEqual(['Store Team']);
    expect(body.locationAccess.kind).toBe('selected');
    if (body.locationAccess.kind === 'selected') {
      expect(body.locationAccess.locations.map((l) => l.id).sort()).toEqual(
        [locA, locB].sort(),
      );
      expect(
        body.locationAccess.locations.every((l) => typeof l.name === 'string'),
      ).toBe(true);
    }
  });

  it('two roles at two locations => both access levels, combined locations (not "all")', async () => {
    const res = await detailAs(
      `corpViewer-${suffix}`,
      userIds[`multiRole-${suffix}`],
    ).expect(200);
    const body = res.body as AdminInternalUserDetail;
    expect(body.accessLevels).toEqual(['Alpha Access', 'Bravo Access']);
    expect(body.locationAccess.kind).toBe('selected');
    if (body.locationAccess.kind === 'selected') {
      expect(body.locationAccess.locations.map((l) => l.id).sort()).toEqual(
        [locA, locB].sort(),
      );
    }
  });

  it('a user with zero assignments is represented safely', async () => {
    const res = await detailAs(
      `corpViewer-${suffix}`,
      userIds[`noAccess-${suffix}`],
    ).expect(200);
    const body = res.body as AdminInternalUserDetail;
    expect(body.accessLevels).toEqual([]);
    expect(body.locationAccess).toEqual({ kind: 'none' });
    expect(body.capabilities).toEqual([]);
  });

  it('an unknown user id => 404', async () => {
    await detailAs(`corpViewer-${suffix}`, randomUUID()).expect(404);
  });

  // ---- Capability explanation -------------------------------------

  it('capabilities are grouped plain-language lines, corporate wording for a corporate operator', async () => {
    const res = await detailAs(
      `corpViewer-${suffix}`,
      userIds[`corpTarget-${suffix}`],
    ).expect(200);
    const body = res.body as AdminInternalUserDetail;
    const orders = body.capabilities.find((g) => g.group === 'Orders');
    expect(orders?.items).toEqual([
      'View orders at all locations',
      'Update order status at all locations',
    ]);
    const menu = body.capabilities.find((g) => g.group === 'Menu & Products');
    expect(menu?.items).toEqual([
      'Set prices and availability for all locations',
    ]);
    // No raw permission keys anywhere in the payload.
    expect(JSON.stringify(body)).not.toMatch(/orders\.view|catalog\.overrides/);
  });

  it('location-scoped grants produce "their locations" wording', async () => {
    const res = await detailAs(
      `corpViewer-${suffix}`,
      userIds[`multiRole-${suffix}`],
    ).expect(200);
    const body = res.body as AdminInternalUserDetail;
    const orders = body.capabilities.find((g) => g.group === 'Orders');
    expect(orders?.items).toEqual(['View orders at their locations']);
    const menu = body.capabilities.find((g) => g.group === 'Menu & Products');
    expect(menu?.items).toEqual([
      'Set prices and availability for their locations',
    ]);
  });

  it('an unknown stored permission key never becomes a displayed capability', async () => {
    const res = await detailAs(
      `corpViewer-${suffix}`,
      userIds[`unknownKey-${suffix}`],
    ).expect(200);
    const body = res.body as AdminInternalUserDetail;
    const allItems = body.capabilities.flatMap((g) => g.items);
    expect(allItems).toEqual(['View orders at all locations']);
    expect(JSON.stringify(body)).not.toContain('totally.made.up.key');
  });

  it('empty capability groups are never rendered', async () => {
    const res = await detailAs(
      `corpViewer-${suffix}`,
      userIds[`misleading-${suffix}`],
    ).expect(200);
    const body = res.body as AdminInternalUserDetail;
    expect(body.capabilities.map((g) => g.group)).toEqual(['Orders']);
    expect(body.capabilities[0].items).toEqual([
      'View orders at their locations',
    ]);
  });

  // ---- Authorization: name is a label, not authority ---------------

  it('a misleading role display name is shown as a label but grants no extra capability', async () => {
    const res = await detailAs(
      `corpViewer-${suffix}`,
      userIds[`misleading-${suffix}`],
    ).expect(200);
    const body = res.body as AdminInternalUserDetail;
    expect(body.accessLevels).toEqual(['Full System Administrator']);
    expect(body.capabilities.flatMap((g) => g.items)).toEqual([
      'View orders at their locations',
    ]);
  });

  it('the effective capability summary matches AuthorizationService resolution, not the role name', async () => {
    // Legacy Role is named neutrally and holds orders.view corporately +
    // one bogus key; the summary must be exactly the one real capability.
    const res = await detailAs(
      `corpViewer-${suffix}`,
      userIds[`unknownKey-${suffix}`],
    ).expect(200);
    const body = res.body as AdminInternalUserDetail;
    expect(body.accessLevels).toEqual(['Legacy Role']);
    expect(body.capabilities).toEqual([
      { group: 'Orders', items: ['View orders at all locations'] },
    ]);
  });
});
