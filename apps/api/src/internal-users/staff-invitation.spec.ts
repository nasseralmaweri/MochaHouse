import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { AdminStaffInvitationResponse } from '@mocha-house/contracts';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { InternalUsersModule } from './internal-users.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import {
  STAFF_LOGIN_PROVIDER,
  type StaffLoginInvitationOutcome,
} from './infrastructure/staff-login-provider';

type Status = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

// V1 launch fix 2 — adding an employee and their first sign-in, over real
// local Postgres, with the identity provider MOCKED (no AWS call, no email).
// The seeded platform administrator is suspended for the run (restored after)
// so the actors are exactly the fixtures here.
describe('Staff invitation: add an employee, first verified sign-in (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'staff-invitation-spec-internal-secret';
  const suffix = randomUUID().slice(0, 8);
  const A = TENANT_1_MOCHA_HOUSE_ID;
  const B = TEST_TENANT_B_ID;

  const invite = jest.fn<
    Promise<StaffLoginInvitationOutcome>,
    [{ email: string; displayName: string }]
  >();

  let locA: string;
  let locB: string;
  let locInactive: string;
  let locTenantB: string;
  let storeManagerRoleId: string;
  let platformAdminRoleId: string;
  let tenantBRoleId: string;
  let seededAdminId: string | null = null;
  let seededAdminStatus: Status = 'ACTIVE';
  const userIds: string[] = [];
  const roleIds: string[] = [];

  // A staff sign-in token. `verified` is the provider's email_verified claim.
  const token = (
    subject: string,
    email: string | null = null,
    verified = false,
  ) =>
    signInternalDevJwt(
      {
        sub: subject,
        email,
        name: null,
        ...(verified ? { email_verified: true } : {}),
      },
      internalSecret,
      3600,
    );
  const actorToken = (key: string) =>
    token(`internal-dev:${key}-${suffix}`, `${key}-${suffix}@example.com`);

  async function makeActor(
    key: string,
    roleId: string,
    scope: { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null }[],
  ) {
    const user = await prisma.internalUser.create({
      data: {
        tenantId: A,
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${key}-${suffix}`,
        email: `${key}-${suffix}@example.com`,
        displayName: key,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(user.id);
    for (const s of scope) {
      await prisma.internalUserRoleAssignment.create({
        data: { tenantId: A, internalUserId: user.id, roleId, ...s },
      });
    }
    return user.id;
  }

  async function makeRole(tenantId: string, name: string, keys: string[]) {
    const role = await prisma.internalRole.create({
      data: {
        tenantId,
        key: `staff-invite-spec-${randomUUID()}`,
        displayName: name,
        permissions: {
          create: keys.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    roleIds.push(role.id);
    return role.id;
  }

  const addEmployee = (actorKey: string, body: unknown) =>
    request(app.getHttpServer())
      .post('/api/v1/admin/internal-users')
      .set('Authorization', `Bearer ${actorToken(actorKey)}`)
      .send(body as object);

  const email = (name: string) => `${name}-${suffix}@staff.example.com`;

  const track = async (address: string) => {
    const rows = await prisma.internalUser.findMany({
      where: { email: address },
      select: { id: true },
    });
    userIds.push(...rows.map((r) => r.id));
  };

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;
    process.env.AUTH_PROVIDER = 'dev';
    process.env.AUTH_DEV_JWT_SECRET = 'staff-invitation-spec-customer-secret';
    process.env.RATE_LIMIT_ENABLED = '0';

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        InternalUsersModule,
      ],
    })
      .overrideProvider(STAFF_LOGIN_PROVIDER)
      .useValue({ providerName: 'internal-dev', inviteLogin: invite })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    const seeded = await prisma.internalUser.findUnique({
      where: {
        tenantId_email: { tenantId: A, email: 'admin@mochahouse.test' },
      },
      select: { id: true, status: true },
    });
    if (seeded) {
      seededAdminId = seeded.id;
      seededAdminStatus = seeded.status;
      await prisma.internalUser.update({
        where: { id: seeded.id },
        data: { status: 'SUSPENDED' },
      });
    }

    await createTestTenantB(prisma);
    storeManagerRoleId = (
      await prisma.internalRole.findUniqueOrThrow({
        where: { tenantId_key: { tenantId: A, key: 'store-manager' } },
      })
    ).id;
    platformAdminRoleId = (
      await prisma.internalRole.findUniqueOrThrow({
        where: { tenantId_key: { tenantId: A, key: 'platform-administrator' } },
      })
    ).id;
    const loc = async (tenantId: string, name: string, isActive = true) =>
      (
        await prisma.location.create({
          data: {
            tenantId,
            name: `Staff Spec ${name} ${suffix}`,
            slug: `staff-${name.toLowerCase()}-${suffix}`,
            isActive,
          },
        })
      ).id;
    locA = await loc(A, 'A');
    locB = await loc(A, 'B');
    locInactive = await loc(A, 'Inactive', false);
    locTenantB = await loc(B, 'TenantB');
    tenantBRoleId = await makeRole(B, 'Tenant B Store', ['orders.view']);

    // Actors.
    await makeActor('owner', platformAdminRoleId, [
      { scopeType: 'CORPORATE', scopeId: null },
    ]);
    await makeActor('viewer', await makeRole(A, 'Viewer', ['users.view']), [
      { scopeType: 'CORPORATE', scopeId: null },
    ]);
    await makeActor(
      'rolesOnly',
      await makeRole(A, 'Roles only', ['users.view', 'users.manage_roles']),
      [{ scopeType: 'CORPORATE', scopeId: null }],
    );
    // Manages people, and runs store operations at location A only.
    const limited = await makeActor(
      'limited',
      await makeRole(A, 'People', [
        'users.view',
        'users.manage_roles',
        'users.manage_status',
      ]),
      [{ scopeType: 'CORPORATE', scopeId: null }],
    );
    const storeOps = await prisma.internalRolePermission.findMany({
      where: { roleId: storeManagerRoleId },
      select: { permissionKey: true },
    });
    const opsRole = await makeRole(
      A,
      'Ops A',
      storeOps.map((p) => p.permissionKey),
    );
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: A,
        internalUserId: limited,
        roleId: opsRole,
        scopeType: 'LOCATION',
        scopeId: locA,
      },
    });
  });

  beforeEach(() => {
    invite.mockReset();
    invite.mockResolvedValue({ outcome: 'invited' });
  });

  afterAll(async () => {
    const ids = [...new Set(userIds)];
    await prisma.internalAuditEvent.deleteMany({
      where: {
        OR: [
          { actorInternalUserId: { in: ids } },
          { targetType: 'internal_user', targetId: { in: ids } },
        ],
      },
    });
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: ids } },
    });
    await prisma.internalUser.deleteMany({ where: { id: { in: ids } } });
    await prisma.internalRolePermission.deleteMany({
      where: { roleId: { in: roleIds } },
    });
    await prisma.internalRole.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.location.deleteMany({
      where: { id: { in: [locA, locB, locInactive, locTenantB] } },
    });
    await removeTestTenantB(prisma);
    if (seededAdminId) {
      await prisma.internalUser.update({
        where: { id: seededAdminId },
        data: { status: seededAdminStatus },
      });
    }
    await app.close();
    process.env = { ...originalEnv };
  });

  // --- adding an employee ------------------------------------------------------

  it('an administrator adds an employee: INVITED, their access granted, invitation sent, audited — no password anywhere', async () => {
    const address = email('Jamie.Cook');
    const res = await addEmployee('owner', {
      displayName: '  Jamie Cook ',
      email: address.toUpperCase(),
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA, locB] },
    }).expect(201);
    await track(address.toLowerCase());
    const body = res.body as AdminStaffInvitationResponse;
    expect(body.invitation).toBe('INVITATION_SENT');
    expect(body.user).toMatchObject({
      displayName: 'Jamie Cook',
      email: address.toLowerCase(),
      status: 'INVITED',
      loginSetup: 'INVITATION_SENT',
      accessLevels: ['Store Manager'],
    });
    expect(body.user.assignments.map((a) => a.location?.id).sort()).toEqual(
      [locA, locB].sort(),
    );
    // The provider is asked once, with the stored address; nothing secret
    // is ever returned.
    expect(invite).toHaveBeenCalledTimes(1);
    expect(invite.mock.calls[0][0]).toEqual({
      email: address.toLowerCase(),
      displayName: 'Jamie Cook',
    });
    expect(JSON.stringify(res.body)).not.toMatch(
      /password|secret|session|subject/i,
    );

    const row = await prisma.internalUser.findFirstOrThrow({
      where: { tenantId: A, email: address.toLowerCase() },
    });
    expect(row).toMatchObject({
      status: 'INVITED',
      externalSubject: null,
      activatedAt: null,
    });
    expect(row.loginInvitedAt).toBeInstanceOf(Date);
    const audit = await prisma.internalAuditEvent.findMany({
      where: { targetType: 'internal_user', targetId: row.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(audit.map((e) => e.action)).toEqual([
      'user.created',
      'user.role_assigned',
      'user.role_assigned',
      'user.login_invited',
    ]);
  });

  it('refuses people without both staff-management permissions (nothing created, nothing sent)', async () => {
    const body = {
      displayName: 'Nobody',
      email: email('nobody'),
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
    };
    await addEmployee('viewer', body).expect(403);
    await addEmployee('rolesOnly', body).expect(403);
    expect(invite).not.toHaveBeenCalled();
    expect(
      await prisma.internalUser.count({ where: { email: body.email } }),
    ).toBe(0);
  });

  it('the privilege ceiling: no granting access the administrator does not hold there', async () => {
    const base = { displayName: 'Ceiling', email: email('ceiling') };
    await addEmployee('limited', {
      ...base,
      roleId: platformAdminRoleId,
      scope: { kind: 'corporate' },
    }).expect(403);
    await addEmployee('limited', {
      ...base,
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locB] },
    }).expect(403);
    expect(
      await prisma.internalUser.count({ where: { email: base.email } }),
    ).toBe(0);
    // Within their own scope it works.
    await addEmployee('limited', {
      ...base,
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
    }).expect(201);
    await track(base.email);
  });

  it('validates the name, email, access level and locations (this business only, active only)', async () => {
    const ok = {
      displayName: 'Val',
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
    };
    for (const bad of [
      '',
      'not-an-email',
      'a@b',
      'two@@example.com',
      `${'x'.repeat(250)}@example.com`,
    ]) {
      await addEmployee('owner', { ...ok, email: bad }).expect(400);
    }
    await addEmployee('owner', {
      ...ok,
      email: email('val'),
      displayName: '   ',
    }).expect(400);
    await addEmployee('owner', {
      ...ok,
      email: email('val'),
      displayName: 'Bad‮name',
    }).expect(400);
    await addEmployee('owner', {
      ...ok,
      email: email('val'),
      scope: { kind: 'locations', locationIds: [locInactive] },
    }).expect(400);
    // Another business's location or access level: never usable, never
    // disclosed as existing.
    await addEmployee('owner', {
      ...ok,
      email: email('val'),
      scope: { kind: 'locations', locationIds: [locTenantB] },
    }).expect(400);
    await addEmployee('owner', {
      ...ok,
      email: email('val'),
      roleId: tenantBRoleId,
    }).expect(404);
    // A tenant id in the body is simply ignored: the business is the caller's.
    expect(
      await prisma.internalUser.count({ where: { email: email('val') } }),
    ).toBe(0);
    expect(invite).not.toHaveBeenCalled();
  });

  it('one person per address in a business (any letter case); the same address may join another business', async () => {
    const address = email('dup');
    await addEmployee('owner', {
      displayName: 'Dup',
      email: address,
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
    }).expect(201);
    await track(address);
    const again = await addEmployee('owner', {
      displayName: 'Dup Again',
      email: address.toUpperCase(),
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locB] },
    }).expect(409);
    expect((again.body as { message: string }).message).toMatch(
      /already part of this business/,
    );
    expect(invite).toHaveBeenCalledTimes(1);

    // Business B already has this person: business A can still add them.
    const other = email('both');
    const inB = await prisma.internalUser.create({
      data: {
        tenantId: B,
        externalProvider: 'internal-dev',
        email: other,
        status: 'ACTIVE',
        externalSubject: `internal-dev:both-${suffix}`,
      },
    });
    userIds.push(inB.id);
    await addEmployee('owner', {
      displayName: 'Both',
      email: other,
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
    }).expect(201);
    await track(other);
  });

  it('optional phone and job title are validated and stored; a job title never grants anything', async () => {
    const base = {
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
    };
    for (const phone of ['12345', 'call me', '1'.repeat(16), 7]) {
      await addEmployee('owner', {
        ...base,
        displayName: 'Phone',
        email: email('phone-bad'),
        phone,
      }).expect(400);
    }
    for (const jobTitle of ['x'.repeat(81), 'Owner‮', 42]) {
      await addEmployee('owner', {
        ...base,
        displayName: 'Title',
        email: email('title-bad'),
        jobTitle,
      }).expect(400);
    }

    // "Administrator" as a job title, with Store Manager access at one
    // location: exactly the Store Manager capabilities, nothing more.
    const titled = email('titled');
    const res = await addEmployee('owner', {
      ...base,
      displayName: 'Titled',
      email: titled,
      phone: ' +1 (734) 555-0101 ',
      jobTitle: '  Platform Administrator ',
    }).expect(201);
    await track(titled);
    const body = res.body as AdminStaffInvitationResponse;
    expect(body.user).toMatchObject({
      phone: '+1 (734) 555-0101',
      jobTitle: 'Platform Administrator',
      accessLevels: ['Store Manager'],
    });
    const plain = email('untitled');
    const res2 = await addEmployee('owner', {
      ...base,
      displayName: 'Untitled',
      email: plain,
    }).expect(201);
    await track(plain);
    const plainBody = res2.body as AdminStaffInvitationResponse;
    expect(plainBody.user).toMatchObject({ phone: null, jobTitle: null });
    expect(body.user.capabilities).toEqual(plainBody.user.capabilities);
    expect(body.user.locationAccess).toEqual(plainBody.user.locationAccess);
  });

  it('concurrent attempts to add the same person create exactly one', async () => {
    const address = email('race');
    const body = {
      displayName: 'Race',
      email: address,
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
    };
    const results = await Promise.all(
      [1, 2, 3].map(() => addEmployee('owner', body)),
    );
    await track(address);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
    expect(
      await prisma.internalUser.count({
        where: { tenantId: A, email: address },
      }),
    ).toBe(1);
    expect(invite).toHaveBeenCalledTimes(1);
  });

  it('the provider refuses the address: nothing is left behind, history kept, and the admin can retry (same or corrected address)', async () => {
    const address = email('refused');
    const body = {
      displayName: 'Refused',
      email: address,
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
    };
    invite.mockResolvedValueOnce({ outcome: 'invalid-email' });
    const res = await addEmployee('owner', body).expect(400);
    expect((res.body as { message: string }).message).toMatch(
      /Nothing was added/,
    );
    // No person and no access remain; the history says what happened.
    expect(await prisma.internalUser.count({ where: { email: address } })).toBe(
      0,
    );
    const history = await prisma.internalAuditEvent.findMany({
      where: {
        action: {
          in: ['user.created', 'user.role_assigned', 'user.creation_reverted'],
        },
        afterData: { path: ['email'], equals: address },
      },
      select: { targetId: true },
    });
    expect(history).toHaveLength(1);
    const revertedId = history[0].targetId;
    expect(revertedId).toBeTruthy();
    userIds.push(revertedId);
    expect(
      (
        await prisma.internalAuditEvent.findMany({
          where: { targetType: 'internal_user', targetId: revertedId },
          orderBy: { createdAt: 'asc' },
          select: { action: true },
        })
      ).map((e) => e.action),
    ).toEqual(['user.created', 'user.role_assigned', 'user.creation_reverted']);
    expect(
      await prisma.internalUserRoleAssignment.count({
        where: { internalUserId: revertedId },
      }),
    ).toBe(0);

    // A retry is a fresh attempt — never "already part of this business".
    await addEmployee('owner', body).expect(201);
    await track(address);

    // "Send invitation again" for an existing person never removes them.
    const kept = email('kept');
    invite.mockResolvedValueOnce({ outcome: 'unavailable' });
    await addEmployee('owner', {
      ...body,
      displayName: 'Kept',
      email: kept,
    }).expect(201);
    await track(kept);
    const keptRow = await prisma.internalUser.findFirstOrThrow({
      where: { tenantId: A, email: kept },
    });
    invite.mockResolvedValueOnce({ outcome: 'invalid-email' });
    const retry = await request(app.getHttpServer())
      .post(`/api/v1/admin/internal-users/${keptRow.id}/login-invitation`)
      .set('Authorization', `Bearer ${actorToken('owner')}`)
      .expect(400);
    expect((retry.body as { message: string }).message).toMatch(
      /Cancel this invitation/,
    );
    expect(
      await prisma.internalUser.findUniqueOrThrow({
        where: { id: keptRow.id },
      }),
    ).toMatchObject({ status: 'INVITED', loginInvitedAt: null });
  });

  it('provider unavailable: the person is added, setup pending, nothing claimed sent — a later retry sends it', async () => {
    invite.mockResolvedValueOnce({ outcome: 'unavailable' });
    const address = email('later');
    const res = await addEmployee('owner', {
      displayName: 'Later',
      email: address,
      roleId: storeManagerRoleId,
      scope: { kind: 'locations', locationIds: [locA] },
    }).expect(201);
    await track(address);
    const body = res.body as AdminStaffInvitationResponse;
    expect(body.invitation).toBe('PENDING');
    expect(body.user.loginSetup).toBe('PENDING');
    const row = await prisma.internalUser.findFirstOrThrow({
      where: { tenantId: A, email: address },
    });
    expect(row.loginInvitedAt).toBeNull();
    expect(
      await prisma.internalAuditEvent.count({
        where: { targetId: row.id, action: 'user.login_invited' },
      }),
    ).toBe(0);

    // Retry: confirmed now.
    const retry = await request(app.getHttpServer())
      .post(`/api/v1/admin/internal-users/${row.id}/login-invitation`)
      .set('Authorization', `Bearer ${actorToken('owner')}`)
      .expect(201);
    expect((retry.body as AdminStaffInvitationResponse).invitation).toBe(
      'INVITATION_SENT',
    );
    expect((retry.body as AdminStaffInvitationResponse).user.loginSetup).toBe(
      'INVITATION_SENT',
    );

    // An existing login is reported as such (and never changed).
    invite.mockResolvedValueOnce({ outcome: 'existing-login' });
    const existing = await request(app.getHttpServer())
      .post(`/api/v1/admin/internal-users/${row.id}/login-invitation`)
      .set('Authorization', `Bearer ${actorToken('owner')}`)
      .expect(201);
    expect((existing.body as AdminStaffInvitationResponse).invitation).toBe(
      'EXISTING_LOGIN',
    );

    // Not for someone who already set up their sign-in; not by a viewer.
    const active = await prisma.internalUser.findFirstOrThrow({
      where: { tenantId: A, externalSubject: `internal-dev:owner-${suffix}` },
    });
    await request(app.getHttpServer())
      .post(`/api/v1/admin/internal-users/${active.id}/login-invitation`)
      .set('Authorization', `Bearer ${actorToken('owner')}`)
      .expect(409);
    await request(app.getHttpServer())
      .post(`/api/v1/admin/internal-users/${row.id}/login-invitation`)
      .set('Authorization', `Bearer ${actorToken('viewer')}`)
      .expect(403);
  });

  // --- first sign-in -------------------------------------------------------------

  async function invited(
    name: string,
    opts: { invitedAt?: Date | null; status?: Status; tenantId?: string } = {},
  ) {
    const row = await prisma.internalUser.create({
      data: {
        tenantId: opts.tenantId ?? A,
        externalProvider: 'internal-dev',
        email: email(name),
        displayName: name,
        status: opts.status ?? 'INVITED',
        loginInvitedAt:
          opts.invitedAt === undefined ? new Date() : opts.invitedAt,
      },
    });
    userIds.push(row.id);
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: row.tenantId,
        internalUserId: row.id,
        roleId: row.tenantId === A ? storeManagerRoleId : tenantBRoleId,
        scopeType: 'LOCATION',
        scopeId: row.tenantId === A ? locA : locTenantB,
      },
    });
    return row;
  }

  const me = (bearer: string, tenantId?: string) => {
    const req = request(app.getHttpServer())
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${bearer}`);
    return tenantId ? req.set('x-tenant-id', tenantId) : req;
  };

  it('a verified first sign-in activates the invited employee and binds their login (audited by them)', async () => {
    const row = await invited('first');
    const subject = `cognito-sub-${randomUUID()}`;
    await me(token(subject, email('first').toUpperCase(), true)).expect(200);
    const after = await prisma.internalUser.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after).toMatchObject({ status: 'ACTIVE', externalSubject: subject });
    expect(after.activatedAt).toBeInstanceOf(Date);
    const activation = await prisma.internalAuditEvent.findFirstOrThrow({
      where: { targetId: row.id, action: 'user.activated' },
    });
    expect(activation.actorInternalUserId).toBe(row.id);
    // From now on the login is recognised by its subject.
    await me(token(subject, null, false)).expect(200);
  });

  it('never activates on an unverified email, a pending (unconfirmed) invitation, or a suspended / disabled person', async () => {
    const unverified = await invited('unverified');
    await me(token(`sub-${randomUUID()}`, email('unverified'), false)).expect(
      403,
    );
    const pending = await invited('pending', { invitedAt: null });
    await me(token(`sub-${randomUUID()}`, email('pending'), true)).expect(403);
    const suspended = await invited('suspended', { status: 'SUSPENDED' });
    await me(token(`sub-${randomUUID()}`, email('suspended'), true)).expect(
      403,
    );
    const disabled = await invited('disabled', { status: 'DISABLED' });
    await me(token(`sub-${randomUUID()}`, email('disabled'), true)).expect(403);
    for (const row of [unverified, pending, suspended, disabled]) {
      const after = await prisma.internalUser.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(after.status).toBe(row.status);
      expect(after.externalSubject).toBeNull();
    }
    // Knowing the address is never enough: a token for another address
    // (or none) touches nothing.
    await me(token(`sub-${randomUUID()}`, email('someone-else'), true)).expect(
      403,
    );
  });

  it('an invitation can be withdrawn (INVITED -> DISABLED) and then never activates; INVITED is never activated by an administrator', async () => {
    const row = await invited('withdrawn');
    const setStatus = (status: string) =>
      request(app.getHttpServer())
        .patch(`/api/v1/admin/internal-users/${row.id}/status`)
        .set('Authorization', `Bearer ${actorToken('owner')}`)
        .send({ status, reason: 'Wrong address' });
    await setStatus('ACTIVE').expect(400);
    await setStatus('DISABLED').expect(200);
    await me(token(`sub-${randomUUID()}`, email('withdrawn'), true)).expect(
      403,
    );
    expect(
      await prisma.internalUser.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({
      status: 'DISABLED',
      externalSubject: null,
    });
  });

  it('an invited employee cannot use the Admin before their verified first sign-in', async () => {
    const row = await invited('waiting', { invitedAt: null });
    await request(app.getHttpServer())
      .get('/api/v1/admin/internal-users')
      .set(
        'Authorization',
        `Bearer ${token(`sub-${randomUUID()}`, email('waiting'), true)}`,
      )
      .expect(403);
    expect(
      (await prisma.internalUser.findUniqueOrThrow({ where: { id: row.id } }))
        .status,
    ).toBe('INVITED');
  });

  it('an existing verified login joins a second business without a new identity; the first is untouched', async () => {
    const subject = `cognito-sub-${randomUUID()}`;
    const address = email('twobiz');
    const inA = await prisma.internalUser.create({
      data: {
        tenantId: A,
        externalProvider: 'internal-dev',
        externalSubject: subject,
        email: address,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(inA.id);
    await prisma.internalUserRoleAssignment.create({
      data: {
        tenantId: A,
        internalUserId: inA.id,
        roleId: storeManagerRoleId,
        scopeType: 'LOCATION',
        scopeId: locA,
      },
    });
    const inB = await invited('twobiz', { tenantId: B });

    const businesses = await request(app.getHttpServer())
      .get('/api/v1/internal/businesses')
      .set('Authorization', `Bearer ${token(subject, address, true)}`)
      .expect(200);
    expect(
      (businesses.body as { businesses: { id: string }[] }).businesses
        .map((b) => b.id)
        .sort(),
    ).toEqual([A, B].sort());
    expect(
      await prisma.internalUser.findUniqueOrThrow({ where: { id: inB.id } }),
    ).toMatchObject({
      status: 'ACTIVE',
      externalSubject: subject,
    });
    expect(
      await prisma.internalUser.findUniqueOrThrow({ where: { id: inA.id } }),
    ).toMatchObject({
      status: 'ACTIVE',
      externalSubject: subject,
    });
    await me(token(subject, address, true), B).expect(200);
  });

  it('two logins racing for one invitation: exactly one is bound', async () => {
    const row = await invited('racer');
    const a = `sub-a-${randomUUID()}`;
    const b = `sub-b-${randomUUID()}`;
    const [ra, rb] = await Promise.all([
      me(token(a, email('racer'), true)),
      me(token(b, email('racer'), true)),
    ]);
    const after = await prisma.internalUser.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(after.status).toBe('ACTIVE');
    expect([a, b]).toContain(after.externalSubject);
    const winner = after.externalSubject === a ? ra : rb;
    expect(winner.status).toBe(200);
    // The other login never gets this person's access.
    const loser = after.externalSubject === a ? b : a;
    await me(token(loser, null, false)).expect(403);
  });
});
