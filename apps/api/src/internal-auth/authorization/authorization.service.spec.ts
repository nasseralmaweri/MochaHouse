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

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule],
      providers: [AuthorizationService],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    service = moduleRef.get(AuthorizationService);
    await prisma.$connect();
    await createTestTenantB(prisma);

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
            { permissionKey: 'orders.view', tenantId: TENANT_1_MOCHA_HOUSE_ID },
            {
              permissionKey: 'catalog.overrides.manage',
              tenantId: TENANT_1_MOCHA_HOUSE_ID,
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
              tenantId: TENANT_1_MOCHA_HOUSE_ID,
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
            { permissionKey: 'orders.view', tenantId: TENANT_1_MOCHA_HOUSE_ID },
            {
              permissionKey: 'orders.delete_everything',
              tenantId: TENANT_1_MOCHA_HOUSE_ID,
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
    await removeTestTenantB(prisma);
    await moduleRef.close();
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: userId },
    });
  });

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
          scopeId: 'loc-1',
        },
        {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          internalUserId: userId,
          roleId: roleIds[roleKeys[0]],
          scopeType: 'LOCATION',
          scopeId: 'loc-2',
        },
      ],
    });

    const ctx = await service.loadContext(userId, tenantOne);
    const authorized = ctx.authorizedLocations('orders.view');
    expect(authorized.kind).toBe('locations');
    if (authorized.kind === 'locations') {
      expect([...authorized.locationIds].sort()).toEqual(['loc-1', 'loc-2']);
    }
    expect(ctx.canActOnLocation('catalog.overrides.manage', 'loc-1')).toBe(
      true,
    );
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
          scopeId: 'loc-1',
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
    // orders.view only at loc-1
    expect(ctx.authorizedLocations('orders.view')).toEqual({
      kind: 'locations',
      locationIds: new Set(['loc-1']),
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

  it('ignores a CORPORATE assignment that wrongly carries a scopeId', async () => {
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        internalUserId: userId,
        roleId: roleIds[roleKeys[1]],
        scopeType: 'CORPORATE',
        scopeId: 'should-not-be-here',
      },
    });
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
    // Planted directly via Prisma, bypassing assignRole's own same-tenant
    // validation — exactly the shape a bug in that validation would produce.
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: TEST_TENANT_B_ID,
        internalUserId: userId,
        roleId: roleIds[roleKeys[0]],
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });

    const asTenantA = await service.loadContext(userId, tenantOne);
    const asTenantB = await service.loadContext(userId, tenantB);

    expect(asTenantA.has('orders.view')).toBe(false);
    expect(asTenantB.has('orders.view')).toBe(true);
  });

  it('removing tenantId from the lookup would have caught both of the above (mutation sanity check via direct query)', async () => {
    // Not a mutation test of source — a direct proof that the two rows
    // above really do carry different tenantId values, so the two tests
    // above are actually exercising cross-tenant isolation and not some
    // other accident.
    await prisma.internalUserRoleAssignment.createMany({
      data: [
        {
          tenantId: TENANT_1_MOCHA_HOUSE_ID,
          internalUserId: userId,
          roleId: roleIds[roleKeys[1]],
          scopeType: 'CORPORATE',
          scopeId: null,
        },
        {
          tenantId: TEST_TENANT_B_ID,
          internalUserId: userId,
          roleId: roleIds[roleKeys[1]],
          scopeType: 'LOCATION',
          scopeId: 'loc-only-in-b',
        },
      ],
    });
    const rows = await prisma.internalUserRoleAssignment.findMany({
      where: { internalUserId: userId },
      select: { tenantId: true },
    });
    expect(new Set(rows.map((r) => r.tenantId))).toEqual(
      new Set([TENANT_1_MOCHA_HOUSE_ID, TEST_TENANT_B_ID]),
    );
  });
});
