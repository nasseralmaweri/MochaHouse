import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { AdminRoleDetail, AdminRoleSummary } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { InternalUsersModule } from './internal-users.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';

// Administration → Access Levels read (Milestone 5E-2), end to end over real
// local Postgres.
describe('Admin access levels read (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'admin-roles-spec-internal-secret';
  const customerSecret = 'admin-roles-spec-customer-secret';
  const suffix = randomUUID();

  let locA: string;
  const userIds: string[] = [];
  const roleIds: Record<string, string> = {};

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
    status: 'ACTIVE' | 'SUSPENDED' | 'DISABLED',
  ): Promise<string> {
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

  async function createRole(
    displayName: string,
    permissionKeys: string[],
    options: { isSystem?: boolean; description?: string | null } = {},
  ): Promise<string> {
    const role = await prisma.internalRole.create({
      data: {
        key: `admin-roles-${suffix}-${randomUUID()}`,
        displayName,
        description: options.description ?? null,
        isSystem: options.isSystem ?? false,
        permissions: {
          create: permissionKeys.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    roleIds[displayName] = role.id;
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
          name: `Roles Spec Loc ${suffix}`,
          slug: `roles-loc-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;

    // Callers.
    const rolesViewCorp = await createRole('zzz Roles View Corp', [
      'roles.view',
    ]);
    const rolesViewLoc = await createRole('zzz Roles View Loc', ['roles.view']);
    const ordersOnly = await createRole('zzz Orders Only', ['orders.view']);

    const corpViewer = await createUser(`corpViewer-${suffix}`, 'ACTIVE');
    await assign(corpViewer, rolesViewCorp, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    const locViewer = await createUser(`locViewer-${suffix}`, 'ACTIVE');
    await assign(locViewer, rolesViewLoc, {
      scopeType: 'LOCATION',
      scopeId: locA,
    });
    const noPerm = await createUser(`noPerm-${suffix}`, 'ACTIVE');
    await assign(noPerm, ordersOnly, { scopeType: 'CORPORATE', scopeId: null });
    const suspended = await createUser(`suspended-${suffix}`, 'SUSPENDED');
    await assign(suspended, rolesViewCorp, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    const disabled = await createUser(`disabled-${suffix}`, 'DISABLED');
    await assign(disabled, rolesViewCorp, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    // Target roles under test.
    await createRole(
      `AAA Store Ops ${suffix}`,
      [
        'orders.view',
        'orders.manage_status',
        'catalog.overrides.manage',
        'locations.view',
        'locations.manage_digital_ordering',
      ],
      { isSystem: true, description: 'Runs a store day to day' },
    );
    await createRole(`BBB Read Only ${suffix}`, ['orders.view'], {
      isSystem: false,
    });
    await createRole(`CCC Nobody Has This ${suffix}`, ['locations.view']);
    await createRole(`DDD Legacy ${suffix}`, [
      'orders.view',
      'defunct.legacy.key',
    ]);
    await createRole(`EEE Full System Administrator ${suffix}`, [
      'orders.view',
    ]);

    // People, to establish counts.
    const person1 = await createUser(`countP1-${suffix}`, 'ACTIVE');
    const person2 = await createUser(`countP2-${suffix}`, 'ACTIVE');
    // person1 holds "Store Ops" at CORPORATE and again at LOCATION → 1 person.
    await assign(person1, roleIds[`AAA Store Ops ${suffix}`], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await assign(person1, roleIds[`AAA Store Ops ${suffix}`], {
      scopeType: 'LOCATION',
      scopeId: locA,
    });
    // person2 also holds "Store Ops" → 2 people total.
    await assign(person2, roleIds[`AAA Store Ops ${suffix}`], {
      scopeType: 'LOCATION',
      scopeId: locA,
    });
    // "Read Only" → exactly 1 person.
    await assign(person2, roleIds[`BBB Read Only ${suffix}`], {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
  }, 30_000);

  afterAll(async () => {
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    for (const id of Object.values(roleIds)) {
      await prisma.internalRolePermission.deleteMany({ where: { roleId: id } });
      await prisma.internalRole.deleteMany({ where: { id } });
    }
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.location.deleteMany({ where: { id: locA } });
    await app.close();
    process.env = { ...originalEnv };
  });

  const http = () => request(app.getHttpServer());
  const listAs = (key: string) =>
    http()
      .get('/api/v1/admin/internal-roles')
      .set('Authorization', `Bearer ${token(key)}`);
  const detailAs = (key: string, id: string) =>
    http()
      .get(`/api/v1/admin/internal-roles/${id}`)
      .set('Authorization', `Bearer ${token(key)}`);

  // ---- Authorization -----------------------------------------------

  it('CORPORATE roles.view can list access levels (200)', async () => {
    await listAs(`corpViewer-${suffix}`).expect(200);
  });

  it('CORPORATE roles.view can open an access level detail (200)', async () => {
    await detailAs(
      `corpViewer-${suffix}`,
      roleIds[`BBB Read Only ${suffix}`],
    ).expect(200);
  });

  it('a user without roles.view is denied (403) on list and detail', async () => {
    await listAs(`noPerm-${suffix}`).expect(403);
    await detailAs(
      `noPerm-${suffix}`,
      roleIds[`BBB Read Only ${suffix}`],
    ).expect(403);
  });

  it('a LOCATION-scoped roles.view grant cannot satisfy the CORPORATE-only route (403)', async () => {
    await listAs(`locViewer-${suffix}`).expect(403);
    await detailAs(
      `locViewer-${suffix}`,
      roleIds[`BBB Read Only ${suffix}`],
    ).expect(403);
  });

  it('a customer token is rejected (401)', async () => {
    await http()
      .get('/api/v1/admin/internal-roles')
      .set('Authorization', `Bearer ${customerToken()}`)
      .expect(401);
  });

  it('a SUSPENDED internal user is denied (403)', async () => {
    await listAs(`suspended-${suffix}`).expect(403);
  });

  it('a DISABLED internal user is denied (403)', async () => {
    await listAs(`disabled-${suffix}`).expect(403);
  });

  // ---- Data -------------------------------------------------------

  it('access levels are ordered by display name', async () => {
    const res = await listAs(`corpViewer-${suffix}`).expect(200);
    const body = res.body as AdminRoleSummary[];
    const sorted = [...body].sort(
      (a, b) =>
        a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id),
    );
    expect(body).toEqual(sorted);
  });

  it('the people count is distinct users, not assignment rows', async () => {
    const res = await listAs(`corpViewer-${suffix}`).expect(200);
    const byId = new Map(
      (res.body as AdminRoleSummary[]).map((r) => [r.id, r]),
    );
    // Store Ops: person1 (x2 assignments) + person2 => 2 people.
    expect(byId.get(roleIds[`AAA Store Ops ${suffix}`])?.userCount).toBe(2);
    // Read Only: person2 only => 1 person.
    expect(byId.get(roleIds[`BBB Read Only ${suffix}`])?.userCount).toBe(1);
  });

  it('a zero-user access level reports userCount 0', async () => {
    const res = await detailAs(
      `corpViewer-${suffix}`,
      roleIds[`CCC Nobody Has This ${suffix}`],
    ).expect(200);
    expect((res.body as AdminRoleDetail).userCount).toBe(0);
  });

  it('an unknown access level id => 404', async () => {
    await detailAs(`corpViewer-${suffix}`, randomUUID()).expect(404);
  });

  it('isSystem is surfaced only as the isBuiltIn presentation flag', async () => {
    const res = await listAs(`corpViewer-${suffix}`).expect(200);
    const byId = new Map(
      (res.body as AdminRoleSummary[]).map((r) => [r.id, r]),
    );
    expect(byId.get(roleIds[`AAA Store Ops ${suffix}`])?.isBuiltIn).toBe(true);
    expect(byId.get(roleIds[`BBB Read Only ${suffix}`])?.isBuiltIn).toBe(false);
    // No role key / raw permission keys / isSystem in the payload.
    expect(JSON.stringify(res.body)).not.toMatch(
      /"key"|"isSystem"|orders\.view|permissionKey/,
    );
  });

  it('known permissions become the expected grouped capability template', async () => {
    const res = await detailAs(
      `corpViewer-${suffix}`,
      roleIds[`AAA Store Ops ${suffix}`],
    ).expect(200);
    const body = res.body as AdminRoleDetail;
    expect(body.capabilities).toEqual([
      { group: 'Orders', items: ['View orders', 'Update order status'] },
      {
        group: 'Menu & Products',
        items: ['Set location prices and availability'],
      },
      {
        group: 'Locations',
        items: ['View locations', 'Turn online ordering on or off'],
      },
    ]);
    expect(JSON.stringify(body)).not.toMatch(
      /orders\.view|catalog\.overrides|locations\./,
    );
  });

  it('an unknown stored permission key is omitted from the capability template', async () => {
    const res = await detailAs(
      `corpViewer-${suffix}`,
      roleIds[`DDD Legacy ${suffix}`],
    ).expect(200);
    const body = res.body as AdminRoleDetail;
    expect(body.capabilities).toEqual([
      { group: 'Orders', items: ['View orders'] },
    ]);
    expect(JSON.stringify(body)).not.toContain('defunct.legacy.key');
  });

  it('a misleading role display name implies no additional capability', async () => {
    const res = await detailAs(
      `corpViewer-${suffix}`,
      roleIds[`EEE Full System Administrator ${suffix}`],
    ).expect(200);
    const body = res.body as AdminRoleDetail;
    expect(body.displayName).toContain('Full System Administrator');
    expect(body.capabilities).toEqual([
      { group: 'Orders', items: ['View orders'] },
    ]);
  });
});
