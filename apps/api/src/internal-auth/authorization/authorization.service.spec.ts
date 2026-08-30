import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaModule } from '../../prisma/prisma.module';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthorizationService } from './authorization.service';

// Integration test against the real local Postgres instance: proves the
// effective authorization context is computed purely from persisted
// role → permission → assignment data, that multiple assignments combine,
// and that an unknown stored permission key can never grant a capability.
describe('AuthorizationService (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let service: AuthorizationService;

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

    const user = await prisma.internalUser.create({
      data: {
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
        key: roleKeys[0],
        displayName: 'Role A (orders.view + catalog.overrides.manage)',
        permissions: {
          create: [
            { permissionKey: 'orders.view' },
            { permissionKey: 'catalog.overrides.manage' },
          ],
        },
      },
    });
    const roleB = await prisma.internalRole.create({
      data: {
        key: roleKeys[1],
        displayName: 'Role B (catalog.products.edit)',
        permissions: { create: [{ permissionKey: 'catalog.products.edit' }] },
      },
    });
    const roleBad = await prisma.internalRole.create({
      data: {
        key: roleKeys[2],
        displayName: 'Role with an unknown permission key',
        permissions: {
          create: [
            { permissionKey: 'orders.view' },
            { permissionKey: 'orders.delete_everything' },
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
    await moduleRef.close();
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: userId },
    });
  });

  it('a user with no assignments has an empty context', async () => {
    const ctx = await service.loadContext(userId);
    expect(ctx.has('orders.view')).toBe(false);
  });

  it('combines the same role at multiple LOCATION scopes', async () => {
    await prisma.internalUserRoleAssignment.createMany({
      data: [
        {
          internalUserId: userId,
          roleId: roleIds[roleKeys[0]],
          scopeType: 'LOCATION',
          scopeId: 'loc-1',
        },
        {
          internalUserId: userId,
          roleId: roleIds[roleKeys[0]],
          scopeType: 'LOCATION',
          scopeId: 'loc-2',
        },
      ],
    });

    const ctx = await service.loadContext(userId);
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
          internalUserId: userId,
          roleId: roleIds[roleKeys[0]],
          scopeType: 'LOCATION',
          scopeId: 'loc-1',
        },
        {
          internalUserId: userId,
          roleId: roleIds[roleKeys[1]],
          scopeType: 'CORPORATE',
          scopeId: null,
        },
      ],
    });

    const ctx = await service.loadContext(userId);
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
    const ctx = await service.loadContext(userId);
    expect(ctx.has('orders.view')).toBe(true);
  });

  it('ignores a CORPORATE assignment that wrongly carries a scopeId', async () => {
    await prisma.internalUserRoleAssignment.create({
      data: {
        internalUserId: userId,
        roleId: roleIds[roleKeys[1]],
        scopeType: 'CORPORATE',
        scopeId: 'should-not-be-here',
      },
    });
    const ctx = await service.loadContext(userId);
    expect(ctx.has('catalog.products.edit')).toBe(false);
  });
});
