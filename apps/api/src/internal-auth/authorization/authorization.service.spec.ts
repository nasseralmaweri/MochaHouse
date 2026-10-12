import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
  tenantContextFor,
} from '@mocha-house/testing';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthorizationService } from './authorization.service';

// Integration test against the real local Postgres instance: proves the
// effective authorization context is computed purely from persisted
// role → permission → assignment data, that multiple assignments combine,
// that an unknown stored permission key can never grant a capability, and
// (Milestone S0D-2E) that it is scoped to the caller's own tenant.
describe('AuthorizationService (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let service: AuthorizationService;

  const tenantOne = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
  const tenantB = tenantContextFor(TEST_TENANT_B_ID);

  const suffix = randomUUID();
  const userEmail = `authz-svc-${suffix}@example.com`;
  const roleKeys = [
    `authz-svc-a-${suffix}`,
    `authz-svc-b-${suffix}`,
    `authz-svc-bad-${suffix}`,
  ];
  let userId: string;
  const roleIds: Record<string, string> = {};
  // Milestone S0F — LOCATION grants only count for locations the active
  // tenant actually owns, so these are real Location rows.
  let loc1: string;
  let loc2: string;
  let locInB: string;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [AuthorizationService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(AuthorizationService);
    await prisma.$connect();
    await createTestTenantB(prisma);

    const makeLocation = async (tenantId: string, label: string) =>
      (
        await prisma.location.create({
          data: {
            tenantId,
            name: `Authz Svc ${label} ${suffix}`,
            slug: `authz-svc-${label}-${suffix}`,
          },
        })
      ).id;
    loc1 = await makeLocation(TENANT_1_MOCHA_HOUSE_ID, 'one');
    loc2 = await makeLocation(TENANT_1_MOCHA_HOUSE_ID, 'two');
    locInB = await makeLocation(TEST_TENANT_B_ID, 'in-b');

    const user = await prisma.internalUser.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${userEmail}`,
        email: userEmail,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userId = user.id;

    const roleA = await prisma.internalRole.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        key: roleKeys[0],
        displayName: 'Role A (orders.view + catalog.overrides.manage)',
        permissions: {
          create: [
            { permissionKey: 'orders.view' },
            {
              permissionKey: 'catalog.overrides.manage',
            },
          ],
        },
      },
    });
    const roleB = await prisma.internalRole.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        key: roleKeys[1],
        displayName: 'Role B (catalog.products.edit)',
        permissions: {
          create: [
            {
              permissionKey: 'catalog.products.edit',
            },
          ],
        },
      },
    });
    const roleBad = await prisma.internalRole.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        key: roleKeys[2],
        displayName: 'Role with an unknown permission key',
        permissions: {
          create: [
            { permissionKey: 'orders.view' },
            {
              permissionKey: 'orders.delete_everything',
            },
          ],
        },
      },
    });
    roleIds[roleKeys[0]] = roleA.id;
    roleIds[roleKeys[1]] = roleB.id;
    roleIds[roleKeys[2]] = roleBad.id;
  });

  afterAll(async () => {
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: userId },
    });
    for (const id of Object.values(roleIds)) {
      await prisma.internalRolePermission.deleteMany({ where: { roleId: id } });
      await prisma.internalRole.deleteMany({ where: { id } });
    }
    await prisma.internalUser.deleteMany({ where: { id: userId } });
    await prisma.location.deleteMany({
      where: { id: { in: [loc1, loc2, locInB] } },
    });
    await removeTestTenantB(prisma);
    await moduleRef.close();
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: userId },
    });
  });

  // Since Security 4C-5 PostgreSQL refuses a cross-business grant outright
  // (composite foreign keys). Rows written before that can only be pictured
  // as legacy data: planted with foreign-key triggers suspended, they must
  // still never surface.
  async function plantLegacyAssignment(row: {
    tenantId: string;
    roleId: string;
    scopeType: 'CORPORATE' | 'LOCATION';
    scopeId: string | null;
  }) {
    await prisma.$transaction([
      prisma.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      prisma.$executeRawUnsafe(
        `INSERT INTO "InternalUserRoleAssignment" ("id", "tenantId", "internalUserId", "roleId", "scopeType", "scopeId", "updatedAt")
         VALUES ($1, $2, $3, $4, $5::"InternalScopeType", $6, now())`,
        randomUUID(),
        row.tenantId,
        userId,
        row.roleId,
        row.scopeType,
        row.scopeId,
      ),
    ]);
  }

  it('a user with no assignments has an empty context', async () => {
    const ctx = await service.loadContext(userId, tenantOne);
    expect(ctx.has('orders.view')).toBe(false);
  });

  it('combines the same role at multiple LOCATION scopes', async () => {
    await prisma.internalUserRoleAssignment.createMany({
      data: [
        {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          internalUserId: userId,
          roleId: roleIds[roleKeys[0]],
          scopeType: 'LOCATION',
          scopeId: loc1,
        },
        {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          internalUserId: userId,
          roleId: roleIds[roleKeys[0]],
          scopeType: 'LOCATION',
          scopeId: loc2,
        },
      ],
    });

    const ctx = await service.loadContext(userId, tenantOne);
    const authorized = ctx.authorizedLocations('orders.view');
    expect(authorized.kind).toBe('locations');
    if (authorized.kind === 'locations') {
      expect([...authorized.locationIds].sort()).toEqual([loc1, loc2].sort());
    }
    expect(ctx.canActOnLocation('catalog.overrides.manage', loc1)).toBe(true);
    expect(ctx.canActOnLocation('catalog.overrides.manage', 'loc-9')).toBe(
      false,
    );
  });

  it('a CORPORATE assignment and LOCATION assignments coexist', async () => {
    await prisma.internalUserRoleAssignment.createMany({
      data: [
        {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          internalUserId: userId,
          roleId: roleIds[roleKeys[0]],
          scopeType: 'LOCATION',
          scopeId: loc1,
        },
        {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          internalUserId: userId,
          roleId: roleIds[roleKeys[1]],
          scopeType: 'CORPORATE',
          scopeId: null,
        },
      ],
    });

    const ctx = await service.loadContext(userId, tenantOne);
    // orders.view only at loc1
    expect(ctx.authorizedLocations('orders.view')).toEqual({
      kind: 'locations',
      locationIds: new Set([loc1]),
    });
    // catalog.products.edit corporate-wide
    expect(ctx.has('catalog.products.edit')).toBe(true);
    expect(ctx.authorizedLocations('catalog.products.edit')).toEqual({
      kind: 'all',
    });
  });

  it('drops an unknown stored permission key without error — it never grants a capability', async () => {
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        internalUserId: userId,
        roleId: roleIds[roleKeys[2]],
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });

    // loadContext must not throw on the unknown "orders.delete_everything"
    // key, and the known key from the same role must still be granted. The
    // unknown key is simply never added to the context, so no code path can
    // ever honour it.
    const ctx = await service.loadContext(userId, tenantOne);
    expect(ctx.has('orders.view')).toBe(true);
  });

  it('a CORPORATE assignment that carries a scopeId cannot exist (Security 4C-5 CHECK), so it can never grant anything', async () => {
    await expect(
      prisma.internalUserRoleAssignment.create({
        data: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          internalUserId: userId,
          roleId: roleIds[roleKeys[1]],
          scopeType: 'CORPORATE',
          scopeId: 'should-not-be-here',
        },
      }),
    ).rejects.toThrow(/InternalUserRoleAssignment_scope_shape_check/);
    expect(
      await prisma.internalUserRoleAssignment.count({
        where: { internalUserId: userId },
      }),
    ).toBe(0);
    const ctx = await service.loadContext(userId, tenantOne);
    expect(ctx.has('catalog.products.edit')).toBe(false);
  });

  // --- Milestone S0D-2E: tenant-scoped authorization ---------------------
  //
  // loadContext(internalUserId, tenant) filters role assignments by BOTH
  // internalUserId AND tenant.tenantId. These prove that filter is load-
  // bearing, not redundant with anything upstream — a row planted directly
  // (bypassing the application's own same-tenant write guards) must still
  // never surface.

  it("a Tenant A assignment is invisible when evaluated under Tenant B's context", async () => {
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        internalUserId: userId,
        roleId: roleIds[roleKeys[0]],
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });

    const asTenantA = await service.loadContext(userId, tenantOne);
    const asTenantB = await service.loadContext(userId, tenantB);

    expect(asTenantA.has('orders.view')).toBe(true);
    expect(asTenantB.has('orders.view')).toBe(false);
  });

  it("a row whose OWN tenantId is Tenant B is invisible under Tenant A's context, even addressed by the same internalUserId", async () => {
    // Written directly via Prisma, bypassing assignRole's own same-tenant
    // validation — exactly the shape a bug in that validation would
    // produce. The database refuses it (Security 4C-5)...
    await expect(
      prisma.internalUserRoleAssignment.create({
        data: {
          tenantId: TEST_TENANT_B_ID,
          internalUserId: userId,
          roleId: roleIds[roleKeys[0]],
          scopeType: 'CORPORATE',
          scopeId: null,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    // ...and as pre-4C-5 legacy data it stays invisible to Tenant A.
    await plantLegacyAssignment({
      tenantId: TEST_TENANT_B_ID,
      roleId: roleIds[roleKeys[0]],
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    const asTenantA = await service.loadContext(userId, tenantOne);
    expect(asTenantA.has('orders.view')).toBe(false);
    // Under Tenant B the row no longer even joins to Tenant A's role: the
    // role relation is (tenantId, roleId) since Security 4C-5, so it never
    // resolves to another business's role and evaluation fails closed
    // (before 4C-5 it granted that role's permissions under Tenant B).
    await expect(service.loadContext(userId, tenantB)).rejects.toThrow();
  });

  it('removing tenantId from the lookup would have caught both of the above (mutation sanity check via direct query)', async () => {
    // Not a mutation test of source — a direct proof that the two rows
    // above really do carry different tenantId values, so the two tests
    // above are actually exercising cross-tenant isolation and not some
    // other accident.
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        internalUserId: userId,
        roleId: roleIds[roleKeys[1]],
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });
    await plantLegacyAssignment({
      tenantId: TEST_TENANT_B_ID,
      roleId: roleIds[roleKeys[1]],
      scopeType: 'LOCATION',
      scopeId: 'loc-only-in-b',
    });
    const rows = await prisma.internalUserRoleAssignment.findMany({
      where: { internalUserId: userId },
      select: { tenantId: true },
    });
    expect(new Set(rows.map((r) => r.tenantId))).toEqual(
      new Set([TENANT_1_MOCHA_HOUSE_ID, TEST_TENANT_B_ID]),
    );
  });

  // --- Milestone S0F: location scope is bounded to the active tenant ---

  it("a CORPORATE grant covers every location of ITS tenant, never another tenant's location", async () => {
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        internalUserId: userId,
        roleId: roleIds[roleKeys[0]],
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });

    const ctx = await service.loadContext(userId, tenantOne);
    expect(ctx.canActOnLocation('orders.view', loc1)).toBe(true);
    expect(ctx.canActOnLocation('orders.view', loc2)).toBe(true);
    // A Tenant B location id (e.g. a stale selection) is refused even under
    // a corporate grant, before any resource is read.
    expect(ctx.canActOnLocation('orders.view', locInB)).toBe(false);
    expect(() => ctx.assertCanActOnLocation('orders.view', locInB)).toThrow();
  });

  it("a LOCATION grant pointing at another tenant's location contributes nothing", async () => {
    await expect(
      prisma.internalUserRoleAssignment.create({
        data: {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          internalUserId: userId,
          roleId: roleIds[roleKeys[0]],
          scopeType: 'LOCATION',
          scopeId: locInB,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    await plantLegacyAssignment({
      tenantId: TENANT_1_MOCHA_HOUSE_ID,
      roleId: roleIds[roleKeys[0]],
      scopeType: 'LOCATION',
      scopeId: locInB,
    });

    const ctx = await service.loadContext(userId, tenantOne);
    expect(ctx.has('orders.view')).toBe(false);
    expect(ctx.canActOnLocation('orders.view', locInB)).toBe(false);
    expect(ctx.summarize().locationIds).toEqual([]);
  });
});
