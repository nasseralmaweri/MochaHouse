import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
  tenantContextFor,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { AuditModule } from '../audit/audit.module';
import { AuthorizationService } from '../internal-auth/authorization/authorization.service';
import { AuthorizationContext } from '../internal-auth/authorization/authorization-context';
import { AdminInternalUsersService } from '../internal-users/application/admin-internal-users.service';
import { AdminInternalRolesService } from '../internal-users/application/admin-internal-roles.service';

// Milestone S0D-2E — Tenant-Scoped Internal Identity & Authorization.
// Mirrors tenant-careers-franchising-writes.spec.ts: every service called
// directly with an explicit TenantContext, proving the internal admin
// identity/authorization chain (InternalUser, InternalRole,
// InternalRolePermission, InternalUserRoleAssignment — all four converted
// to required tenant ownership in this milestone) is genuinely tenant-safe,
// not just schema-converted.
describe('S0D-2E internal identity & authorization tenant ownership (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let authorizationService: AuthorizationService;
  let usersService: AdminInternalUsersService;
  let rolesService: AdminInternalRolesService;
  const suffix = randomUUID().slice(0, 8);

  const tenantOne = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
  const tenantB = tenantContextFor(TEST_TENANT_B_ID);
  const corporate = [{ scopeType: 'CORPORATE' as const, scopeId: null }];
  const fullAdmin = AuthorizationContext.of({
    'users.view': corporate,
    'users.manage_status': corporate,
    'users.manage_roles': corporate,
    'roles.view': corporate,
    'catalog.products.edit': corporate,
    'catalog.overrides.manage': corporate,
  });

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const locationIds: string[] = [];
  let actorId: string;

  async function makeUser(
    tenantId: string,
    label: string,
  ): Promise<string> {
    const email = `s0d2e-${label}-${suffix}@example.com`;
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:s0d2e-${label}-${suffix}`,
        email,
        displayName: `S0D2E ${label}`,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  // CORPORATE-only (single corporate-scoped key), consistent with
  // resolveAssignmentShape's fallback rule — assignable without needing a
  // built-in role key.
  async function makeCorporateRole(
    tenantId: string,
    label: string,
  ): Promise<string> {
    const role = await prisma.internalRole.create({
      data: {
        tenantId,
        key: `s0d2e-corp-${label}-${suffix}`,
        displayName: `S0D2E Corporate ${label}`,
        permissions: {
          create: [{ permissionKey: 'catalog.products.edit', tenantId }],
        },
      },
    });
    roleIds.push(role.id);
    return role.id;
  }

  // LOCATION-capable (single location-capable key).
  async function makeLocationRole(
    tenantId: string,
    label: string,
  ): Promise<string> {
    const role = await prisma.internalRole.create({
      data: {
        tenantId,
        key: `s0d2e-loc-${label}-${suffix}`,
        displayName: `S0D2E Location ${label}`,
        permissions: {
          create: [{ permissionKey: 'catalog.overrides.manage', tenantId }],
        },
      },
    });
    roleIds.push(role.id);
    return role.id;
  }

  async function makeLocation(tenantId: string, label: string): Promise<string> {
    const location = await prisma.location.create({
      data: {
        tenantId,
        name: `S0D2E ${label} ${suffix}`,
        slug: `s0d2e-${label}-${suffix}`,
      },
    });
    locationIds.push(location.id);
    return location.id;
  }

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [PrismaModule, AuditModule],
      providers: [
        AuthorizationService,
        AdminInternalUsersService,
        AdminInternalRolesService,
      ],
    }).compile();
    prisma = moduleRef.get(PrismaService);
    authorizationService = moduleRef.get(AuthorizationService);
    usersService = moduleRef.get(AdminInternalUsersService);
    rolesService = moduleRef.get(AdminInternalRolesService);
    await prisma.$connect();
    await createTestTenantB(prisma);

    actorId = await makeUser(TENANT_1_MOCHA_HOUSE_ID, 'actor');
  });

  afterAll(async () => {
    await prisma.internalAuditEvent.deleteMany({
      where: { actorInternalUserId: { in: [...userIds, actorId] } },
    });
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    await prisma.internalRolePermission.deleteMany({
      where: { roleId: { in: roleIds } },
    });
    await prisma.internalRole.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.location.deleteMany({ where: { id: { in: locationIds } } });
    await removeTestTenantB(prisma);
    await moduleRef.close();
    await prisma.$disconnect();
  });

  // --- Proof 1/2: a tenant's internal user cannot receive the other
  // tenant's authorization -------------------------------------------

  it('(1) a Tenant A internal user cannot receive Tenant B authorization', async () => {
    const userA = await makeUser(TENANT_1_MOCHA_HOUSE_ID, 'auth-a');
    const roleA = await makeCorporateRole(TENANT_1_MOCHA_HOUSE_ID, 'auth-a');
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        internalUserId: userA,
        roleId: roleA,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });

    const asB = await authorizationService.loadContext(userA, tenantB);
    expect(asB.has('catalog.products.edit')).toBe(false);
  });

  it('(2) a Tenant B internal user cannot receive Tenant A authorization', async () => {
    const userB = await makeUser(TEST_TENANT_B_ID, 'auth-b');
    const roleB = await makeCorporateRole(TEST_TENANT_B_ID, 'auth-b');
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: TEST_TENANT_B_ID,
        internalUserId: userB,
        roleId: roleB,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });

    const asA = await authorizationService.loadContext(userB, tenantOne);
    expect(asA.has('catalog.products.edit')).toBe(false);
  });

  // --- Proof 3/4: role assignments are invisible across tenants,
  // evaluated from the SAME internalUserId ----------------------------

  it('(3) Tenant A role assignments are invisible to Tenant B authorization evaluation', async () => {
    const userA = await makeUser(TENANT_1_MOCHA_HOUSE_ID, 'eval-a');
    const roleA = await makeCorporateRole(TENANT_1_MOCHA_HOUSE_ID, 'eval-a');
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: TENANT_1_MOCHA_HOUSE_ID,
        internalUserId: userA,
        roleId: roleA,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });

    expect((await authorizationService.loadContext(userA, tenantOne)).has('catalog.products.edit')).toBe(true);
    expect((await authorizationService.loadContext(userA, tenantB)).has('catalog.products.edit')).toBe(false);
  });

  it('(4) Tenant B role assignments are invisible to Tenant A authorization evaluation', async () => {
    const userB = await makeUser(TEST_TENANT_B_ID, 'eval-b');
    const roleB = await makeCorporateRole(TEST_TENANT_B_ID, 'eval-b');
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: TEST_TENANT_B_ID,
        internalUserId: userB,
        roleId: roleB,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });

    expect((await authorizationService.loadContext(userB, tenantB)).has('catalog.products.edit')).toBe(true);
    expect((await authorizationService.loadContext(userB, tenantOne)).has('catalog.products.edit')).toBe(false);
  });

  // --- Proof 5/6: a user cannot be ASSIGNED a foreign-tenant role, in
  // either direction, via the real admin write path -------------------

  it('(5) a Tenant A user cannot be assigned a Tenant B role', async () => {
    const userA = await makeUser(TENANT_1_MOCHA_HOUSE_ID, 'assign-a-user');
    const roleB = await makeCorporateRole(TEST_TENANT_B_ID, 'assign-a-role');

    await expect(
      usersService.assignRole(
        userA,
        { roleId: roleB, scope: { kind: 'corporate' }, reason: 'cross-tenant attempt' },
        actorId,
        fullAdmin,
        tenantOne,
      ),
    ).rejects.toThrow(new NotFoundException('Access level not found.'));

    expect(
      await prisma.internalUserRoleAssignment.count({
        where: { internalUserId: userA },
      }),
    ).toBe(0);
  });

  it('(6) a Tenant B user cannot be assigned a Tenant A role', async () => {
    const userB = await makeUser(TEST_TENANT_B_ID, 'assign-b-user');
    const roleA = await makeCorporateRole(TENANT_1_MOCHA_HOUSE_ID, 'assign-b-role');

    await expect(
      usersService.assignRole(
        userB,
        { roleId: roleA, scope: { kind: 'corporate' }, reason: 'cross-tenant attempt' },
        actorId,
        fullAdmin,
        tenantB,
      ),
    ).rejects.toThrow(new NotFoundException('Access level not found.'));

    expect(
      await prisma.internalUserRoleAssignment.count({
        where: { internalUserId: userB },
      }),
    ).toBe(0);
  });

  it('a Tenant A admin cannot target a Tenant B user at all — no row is EVER persisted, whatever the rejection reason', async () => {
    const userB = await makeUser(TEST_TENANT_B_ID, 'target-b');
    const roleA = await makeCorporateRole(TENANT_1_MOCHA_HOUSE_ID, 'target-a-role');

    await expect(
      usersService.assignRole(
        userB,
        { roleId: roleA, scope: { kind: 'corporate' }, reason: 'cross-tenant target' },
        actorId,
        fullAdmin,
        tenantOne,
      ),
    ).rejects.toThrow(new NotFoundException('Internal user not found.'));

    // The decisive check: regardless of WHERE the rejection came from (the
    // write-path's own check, or some other guard catching it later), a
    // Tenant-B-user-assigned-Tenant-A-role row must never exist in the
    // database — a later check throwing is not a substitute for the
    // write itself never having happened.
    expect(
      await prisma.internalUserRoleAssignment.count({
        where: { internalUserId: userB, roleId: roleA },
      }),
    ).toBe(0);
  });

  // --- Proof 7: role-permission relationships remain tenant-safe -----

  it('(7) a role-permission relationship never crosses tenants: a role carries only ITS OWN tenant permissions', async () => {
    const roleA = await makeCorporateRole(TENANT_1_MOCHA_HOUSE_ID, 'rp-a');
    const roleB = await makeCorporateRole(TEST_TENANT_B_ID, 'rp-b');

    const permsA = await prisma.internalRolePermission.findMany({
      where: { roleId: roleA },
    });
    const permsB = await prisma.internalRolePermission.findMany({
      where: { roleId: roleB },
    });
    expect(permsA.every((p) => p.tenantId === TENANT_1_MOCHA_HOUSE_ID)).toBe(true);
    expect(permsB.every((p) => p.tenantId === TEST_TENANT_B_ID)).toBe(true);
  });

  // --- Proof 8: spoofed tenant data cannot influence authorization ---

  it('(8) a role-assignment row whose OWN tenantId was planted as Tenant B still cannot grant Tenant A authorization for that user', async () => {
    const userA = await makeUser(TENANT_1_MOCHA_HOUSE_ID, 'spoof-a');
    const roleB = await makeCorporateRole(TEST_TENANT_B_ID, 'spoof-role');
    // Planted directly, bypassing assignRole's own same-tenant validation —
    // the exact shape a bug in that validation, or a spoofed internal
    // write, would produce.
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: TEST_TENANT_B_ID,
        internalUserId: userA,
        roleId: roleB,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });

    const asTenantA = await authorizationService.loadContext(userA, tenantOne);
    expect(asTenantA.has('catalog.products.edit')).toBe(false);
  });

  // --- Proof 9/10: existing same-tenant behavior is unaffected --------

  it('(9) existing same-tenant admin authorization still works end to end (assign, evaluate, remove)', async () => {
    const userA = await makeUser(TENANT_1_MOCHA_HOUSE_ID, 'e2e-a');
    const roleA = await makeCorporateRole(TENANT_1_MOCHA_HOUSE_ID, 'e2e-a');

    const detail = await usersService.assignRole(
      userA,
      { roleId: roleA, scope: { kind: 'corporate' }, reason: 'grant' },
      actorId,
      fullAdmin,
      tenantOne,
    );
    expect(detail.assignments).toHaveLength(1);

    expect((await authorizationService.loadContext(userA, tenantOne)).has('catalog.products.edit')).toBe(true);

    const assignmentId = detail.assignments[0].id;
    const afterRemoval = await usersService.removeRoleAssignment(
      userA,
      assignmentId,
      { reason: 'revoke' },
      actorId,
      fullAdmin,
      tenantOne,
    );
    expect(afterRemoval.assignments).toHaveLength(0);
    expect((await authorizationService.loadContext(userA, tenantOne)).has('catalog.products.edit')).toBe(false);
  });

  it('(10) listUsers / getAccessOptions / getUserDetail remain tenant-scoped and behaviorally correct for the owning tenant', async () => {
    const userA = await makeUser(TENANT_1_MOCHA_HOUSE_ID, 'list-a');
    const userB = await makeUser(TEST_TENANT_B_ID, 'list-b');

    const listA = await usersService.listUsers(fullAdmin, tenantOne);
    expect(listA.some((u) => u.id === userA)).toBe(true);
    expect(listA.some((u) => u.id === userB)).toBe(false);

    const listB = await usersService.listUsers(fullAdmin, tenantB);
    expect(listB.some((u) => u.id === userB)).toBe(true);
    expect(listB.some((u) => u.id === userA)).toBe(false);

    const detailA = await usersService.getUserDetail(userA, fullAdmin, tenantOne);
    expect(detailA.id).toBe(userA);
    await expect(
      usersService.getUserDetail(userB, fullAdmin, tenantOne),
    ).rejects.toThrow(new NotFoundException('Internal user not found.'));
  });

  it("a Tenant A admin's access-options picker never offers a Tenant B location", async () => {
    const locationA = await makeLocation(TENANT_1_MOCHA_HOUSE_ID, 'opt-a');
    const locationB = await makeLocation(TEST_TENANT_B_ID, 'opt-b');

    const options = await usersService.getAccessOptions(fullAdmin, tenantOne);
    const ids = options.locations.map((l) => l.id);
    expect(ids).toContain(locationA);
    expect(ids).not.toContain(locationB);
  });

  it('a LOCATION-scoped assignment cannot be pointed at a foreign-tenant location', async () => {
    const userA = await makeUser(TENANT_1_MOCHA_HOUSE_ID, 'loc-scope-a');
    const roleA = await makeLocationRole(TENANT_1_MOCHA_HOUSE_ID, 'loc-scope-a');
    const locationB = await makeLocation(TEST_TENANT_B_ID, 'loc-scope-b');

    await expect(
      usersService.assignRole(
        userA,
        {
          roleId: roleA,
          scope: { kind: 'locations', locationIds: [locationB] },
          reason: 'cross-tenant location',
        },
        actorId,
        fullAdmin,
        tenantOne,
      ),
    ).rejects.toThrow(
      'One or more of the chosen locations no longer exists.',
    );

    expect(
      await prisma.internalUserRoleAssignment.count({
        where: { internalUserId: userA },
      }),
    ).toBe(0);
  });

  // --- Proof 11: Administration (Access Levels) read surface is also
  // tenant-scoped ------------------------------------------------------

  it('(11) AdminInternalRolesService.listRoles / getRoleDetail are tenant-scoped', async () => {
    const roleA = await makeCorporateRole(TENANT_1_MOCHA_HOUSE_ID, 'roles-read-a');
    const roleB = await makeCorporateRole(TEST_TENANT_B_ID, 'roles-read-b');

    const rolesA = await rolesService.listRoles(fullAdmin, tenantOne);
    expect(rolesA.some((r) => r.id === roleA)).toBe(true);
    expect(rolesA.some((r) => r.id === roleB)).toBe(false);

    await expect(
      rolesService.getRoleDetail(roleB, fullAdmin, tenantOne),
    ).rejects.toThrow(new NotFoundException('Access level not found.'));
  });

  // --- Proof 12: the last-independent-administrator rule is evaluated
  // PER TENANT, not platform-wide ---------------------------------------
  //
  // Without this, Tenant B having zero administrators could make a
  // Tenant A demotion look unsafe (or vice versa) purely because of an
  // unrelated tenant's headcount.

  it('(12) the last-administrator protection is scoped per tenant', async () => {
    const soleAdminB = await makeUser(TEST_TENANT_B_ID, 'sole-admin-b');
    const protectedRoleB = await prisma.internalRole.create({
      data: {
        tenantId: TEST_TENANT_B_ID,
        key: `s0d2e-protected-b-${suffix}`,
        displayName: 'S0D2E Protected Admin (Tenant B)',
        permissions: {
          create: [
            { permissionKey: 'users.manage_status', tenantId: TEST_TENANT_B_ID },
            { permissionKey: 'users.manage_roles', tenantId: TEST_TENANT_B_ID },
          ],
        },
      },
    });
    roleIds.push(protectedRoleB.id);
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: TEST_TENANT_B_ID,
        internalUserId: soleAdminB,
        roleId: protectedRoleB.id,
        scopeType: 'CORPORATE',
        scopeId: null,
      },
    });

    // Tenant B now has exactly ONE protected administrator and NO other
    // tenant's headcount should matter: Tenant A may have several. If the
    // last-admin query is not tenant-scoped, Tenant A's administrators
    // would incorrectly appear as "independent spares" for Tenant B's
    // check (or vice versa) — this proves the real tenant-B-only count is
    // used by trying to suspend Tenant B's sole admin, which must be
    // refused regardless of how many Tenant A admins exist.
    await expect(
      usersService.updateStatus(
        soleAdminB,
        { status: 'SUSPENDED', reason: 'test' },
        actorId,
        fullAdmin,
        tenantB,
      ),
    ).rejects.toThrow(
      'At least one other active Platform Administrator is required before this person can be suspended or disabled.',
    );

    const stillActive = await prisma.internalUser.findUniqueOrThrow({
      where: { id: soleAdminB },
    });
    expect(stillActive.status).toBe('ACTIVE');
  });
});
