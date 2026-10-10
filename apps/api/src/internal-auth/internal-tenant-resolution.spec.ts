import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import {
  Controller,
  Get,
  INestApplication,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  INTERNAL_PERMISSION_KEYS,
  type InternalBusinessesResponse,
  type InternalMeResponse,
} from '@mocha-house/contracts';
import {
  TENANT_1_MOCHA_HOUSE_ID,
  getCurrentTenantContext,
  type TenantContext,
} from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { LocationsModule } from '../locations/locations.module';
import { CurrentTenantContext } from '../tenancy/current-tenant-context.decorator';
import { InternalAuthModule } from './internal-auth.module';
import { InternalAuthGuard } from './infrastructure/internal-auth.guard';
import type { InternalAuthenticatedRequest } from './infrastructure/internal-identity';
import { signInternalDevJwt } from './infrastructure/internal-dev-jwt';
import { AuthorizationService } from './authorization/authorization.service';

// A member route (under /api/v1/admin) and a public route, so the spec can
// observe exactly which TenantContext each kind of request receives — both
// the explicit one (@CurrentTenantContext) and the async-scoped carrier.
@Controller('api/v1/admin/s0f-probe')
class MemberProbeController {
  @UseGuards(InternalAuthGuard)
  @Get()
  read(
    @CurrentTenantContext() context: TenantContext,
    @Req() request: InternalAuthenticatedRequest,
  ) {
    return {
      context,
      carrier: getCurrentTenantContext() ?? null,
      internalUserTenantId: request.internalUser!.tenantId,
    };
  }
}

@Controller('s0f-public-probe')
class PublicProbeController {
  @Get()
  read(@CurrentTenantContext() context: TenantContext) {
    return { context };
  }
}

// Milestone S0F — Real Admin Tenant Resolution & Minimal Business
// Membership. Real local Postgres, real guards, real modules.
//
//   Tenant A  = Tenant #1 (Mocha House)
//   Tenant B  = the test-only isolation tenant
//   Tenant C  = a SUSPENDED test tenant (created and removed here)
describe('S0F admin tenant resolution & business membership (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 's0f-spec-internal-secret';
  const suffix = randomUUID();

  const TENANT_A = TENANT_1_MOCHA_HOUSE_ID;
  const TENANT_B = TEST_TENANT_B_ID;
  const TENANT_C = '01a0db02-f800-7000-8000-7e570000000c';

  let locA: string;
  let locB: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];

  const subjectOf = (key: string) => `internal-dev:s0f-${key}-${suffix}`;
  const emailOf = (key: string) => `s0f-${key}-${suffix}@example.com`;
  const token = (key: string) =>
    signInternalDevJwt(
      // Each key is a verified human (Security 4A: only a provider-verified
      // email may find or bind an email-provisioned row).
      {
        sub: subjectOf(key),
        email: emailOf(key),
        name: null,
        email_verified: true,
      },
      internalSecret,
      3600,
    );

  async function member(
    key: string,
    tenantId: string,
    opts: {
      status?: 'ACTIVE' | 'SUSPENDED';
      bound?: boolean;
      permissions?: readonly string[];
    } = {},
  ): Promise<string> {
    const user = await prisma.internalUser.create({
      data: {
        tenantId,
        externalProvider: 'internal-dev',
        externalSubject: opts.bound === false ? null : subjectOf(key),
        email: emailOf(key),
        status: opts.status ?? 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(user.id);
    if (opts.permissions && opts.permissions.length > 0) {
      const role = await prisma.internalRole.create({
        data: {
          tenantId,
          key: `s0f-${key}-${randomUUID()}`,
          displayName: 'S0F spec role',
          permissions: {
            create: opts.permissions.map((permissionKey) => ({
              permissionKey,
              tenantId,
            })),
          },
        },
      });
      roleIds.push(role.id);
      await prisma.internalUserRoleAssignment.create({
        data: {
          tenantId,
          internalUserId: user.id,
          roleId: role.id,
          scopeType: 'CORPORATE',
          scopeId: null,
        },
      });
    }
    return user.id;
  }

  async function compileApp(): Promise<INestApplication<App>> {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        LocationsModule,
      ],
      controllers: [MemberProbeController, PublicProbeController],
    }).compile();
    const created =
      moduleFixture.createNestApplication<INestApplication<App>>();
    await created.init();
    return created;
  }

  const http = () => request(app.getHttpServer());
  const me = (key: string, tenantId?: string) => {
    const req = http()
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${token(key)}`);
    return tenantId ? req.set('X-Tenant-Id', tenantId) : req;
  };
  const businesses = (key: string) =>
    http()
      .get('/api/v1/internal/businesses')
      .set('Authorization', `Bearer ${token(key)}`);

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;

    app = await compileApp();
    prisma = app.get(PrismaService);

    await createTestTenantB(prisma);
    await prisma.tenant.upsert({
      where: { id: TENANT_C },
      update: {},
      create: {
        id: TENANT_C,
        slug: 's0f-test-tenant-c',
        name: 'S0F Test Tenant C (suspended)',
        status: 'SUSPENDED',
        suspensionReason: 'REQUESTED',
      },
    });

    locA = (
      await prisma.location.create({
        data: {
          tenantId: TENANT_A,
          name: `S0F A ${suffix}`,
          slug: `s0f-a-${suffix}`,
        },
      })
    ).id;
    locB = (
      await prisma.location.create({
        data: {
          tenantId: TENANT_B,
          name: `S0F B ${suffix}`,
          slug: `s0f-b-${suffix}`,
        },
      })
    ).id;

    const all = INTERNAL_PERMISSION_KEYS;
    // Single-business administrators.
    await member('a-only', TENANT_A, { permissions: all });
    await member('b-only', TENANT_B, { permissions: all });
    // One verified human, two businesses, DIFFERENT authority in each.
    await member('multi', TENANT_A, { permissions: all });
    await member('multi', TENANT_B, { permissions: ['locations.view'] });
    // Member of an ACTIVE business and of a SUSPENDED one.
    await member('a-plus-c', TENANT_A, { permissions: ['locations.view'] });
    await member('a-plus-c', TENANT_C, { permissions: all });
    // Member of a SUSPENDED business only.
    await member('c-only', TENANT_C, { permissions: all });
    // ACTIVE in A, but their B membership is SUSPENDED.
    await member('a-plus-suspended-b', TENANT_A, { permissions: all });
    await member('a-plus-suspended-b', TENANT_B, {
      status: 'SUSPENDED',
      permissions: all,
    });
    // Bound in A; B has provisioned the same email but it is not bound yet.
    await member('invitee', TENANT_A, { permissions: ['locations.view'] });
    await member('invitee', TENANT_B, {
      bound: false,
      permissions: ['locations.view'],
    });
  });

  afterAll(async () => {
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    await prisma.internalRolePermission.deleteMany({
      where: { roleId: { in: roleIds } },
    });
    await prisma.internalRole.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.location.deleteMany({ where: { id: { in: [locA, locB] } } });
    await prisma.tenant.deleteMany({ where: { id: TENANT_C } });
    await removeTestTenantB(prisma);
    await app.close();
    process.env = { ...originalEnv };
  });

  // --- (1)/(2) single-business administrators -------------------------

  it('(1) a Tenant A-only admin resolves Tenant A (implicitly, and when A is requested)', async () => {
    for (const header of [undefined, TENANT_A]) {
      const res = await me('a-only', header).expect(200);
      const body = res.body as InternalMeResponse;
      expect(Object.keys(body.business).sort()).toEqual(['id', 'name', 'slug']);
      expect(body.business.id).toBe(TENANT_A);
      expect(body.business.slug).toBe('mocha-house');
      expect(body.authorization.isCorporate).toBe(true);
    }
  });

  it('(2) a Tenant B-only admin resolves Tenant B', async () => {
    for (const header of [undefined, TENANT_B]) {
      const res = await me('b-only', header).expect(200);
      expect((res.body as InternalMeResponse).business.id).toBe(TENANT_B);
    }
  });

  it('the member TenantContext is established by the guard (principal "member"), and reaches the async carrier', async () => {
    const res = await http()
      .get('/api/v1/admin/s0f-probe')
      .set('Authorization', `Bearer ${token('multi')}`)
      .set('X-Tenant-Id', TENANT_B)
      .expect(200);
    const body = res.body as {
      context: TenantContext;
      carrier: TenantContext | null;
      internalUserTenantId: string;
    };
    expect(body.context.tenantId).toBe(TENANT_B);
    expect(body.context.principalType).toBe('member');
    expect(body.context.requestId).toBe(res.headers['x-request-id']);
    expect(body.carrier).toEqual(body.context);
    expect(body.internalUserTenantId).toBe(TENANT_B);
  });

  // --- (3)/(4)/(8) cross-tenant selection attacks ----------------------

  it('(3) a Tenant A admin cannot select Tenant B', async () => {
    await me('a-only', TENANT_B).expect(403);
    await http()
      .get('/api/v1/admin/locations')
      .set('Authorization', `Bearer ${token('a-only')}`)
      .set('X-Tenant-Id', TENANT_B)
      .expect(403);
  });

  it('(4) a Tenant B admin cannot select Tenant A', async () => {
    await me('b-only', TENANT_A).expect(403);
    await http()
      .get('/api/v1/admin/locations')
      .set('Authorization', `Bearer ${token('b-only')}`)
      .set('X-Tenant-Id', TENANT_A)
      .expect(403);
  });

  it('(8) spoofed / unknown / malformed tenant ids never bypass membership validation', async () => {
    // A well-formed id of a tenant that does not exist: the same 403 as a
    // real tenant the caller is not a member of (no existence oracle).
    const unknown = await me('a-only', randomUUID()).expect(403);
    const foreign = await me('a-only', TENANT_B).expect(403);
    expect(unknown.body).toEqual(foreign.body);

    // Malformed intent is rejected outright — never "fall back".
    await me('a-only', 'mocha-house').expect(400);
    await me('a-only', TENANT_B.toUpperCase()).expect(400);
    await me('a-only', `${TENANT_A}, ${TENANT_B}`).expect(400);

    // Tenant ids anywhere else in the request are simply not read.
    const viaQuery = await http()
      .get(`/api/v1/internal/me?tenantId=${TENANT_B}&tenant=${TENANT_B}`)
      .set('Authorization', `Bearer ${token('a-only')}`)
      .set('X-Tenant', TENANT_B)
      .set('X-Business-Id', TENANT_B)
      .expect(200);
    expect((viaQuery.body as InternalMeResponse).business.id).toBe(TENANT_A);

    // No token at all: authentication is checked before any tenant intent.
    await http()
      .get('/api/v1/internal/me')
      .set('X-Tenant-Id', TENANT_A)
      .expect(401);
  });

  // --- (5)/(6)/(7) one human, two businesses ---------------------------

  it('(5) the multi-business admin resolves Tenant A when selecting A', async () => {
    const res = await me('multi', TENANT_A).expect(200);
    const body = res.body as InternalMeResponse;
    expect(body.business.id).toBe(TENANT_A);
    const row = await prisma.internalUser.findUniqueOrThrow({
      where: {
        tenantId_email: { tenantId: TENANT_A, email: emailOf('multi') },
      },
    });
    expect(body.user.id).toBe(row.id);
  });

  it('(6) the same admin resolves Tenant B when selecting B — a different membership row', async () => {
    const res = await me('multi', TENANT_B).expect(200);
    const body = res.body as InternalMeResponse;
    expect(body.business.id).toBe(TENANT_B);
    const row = await prisma.internalUser.findUniqueOrThrow({
      where: {
        tenantId_email: { tenantId: TENANT_B, email: emailOf('multi') },
      },
    });
    expect(body.user.id).toBe(row.id);
  });

  it('(7) permissions are evaluated independently inside each business', async () => {
    const inA = (await me('multi', TENANT_A).expect(200))
      .body as InternalMeResponse;
    const inB = (await me('multi', TENANT_B).expect(200))
      .body as InternalMeResponse;

    expect(inA.authorization.permissions.sort()).toEqual(
      [...INTERNAL_PERMISSION_KEYS].sort(),
    );
    expect(inB.authorization.permissions).toEqual(['locations.view']);

    // Enforcement, not just the summary: locations.edit is held in A only.
    await http()
      .get('/api/v1/admin/locations')
      .set('Authorization', `Bearer ${token('multi')}`)
      .set('X-Tenant-Id', TENANT_B)
      .expect(200);
    await http()
      .patch(`/api/v1/admin/locations/${locB}`)
      .set('Authorization', `Bearer ${token('multi')}`)
      .set('X-Tenant-Id', TENANT_B)
      .send({ name: 'should not change' })
      .expect(403);
    await http()
      .patch(`/api/v1/admin/locations/${locA}`)
      .set('Authorization', `Bearer ${token('multi')}`)
      .set('X-Tenant-Id', TENANT_A)
      .send({ name: `S0F A ${suffix}` })
      .expect(200);

    // And directly against the authorization engine.
    const authz = app.get(AuthorizationService);
    const rowB = await prisma.internalUser.findUniqueOrThrow({
      where: {
        tenantId_email: { tenantId: TENANT_B, email: emailOf('multi') },
      },
    });
    const ctxB = await authz.loadContext(rowB.id, {
      tenantId: TENANT_B,
      principalType: 'member',
      requestId: 's0f-spec',
    });
    expect(ctxB.has('locations.edit')).toBe(false);
    expect(ctxB.has('locations.view')).toBe(true);
  });

  it('a multi-business admin who selects nothing is asked to choose (409), never defaulted', async () => {
    const res = await me('multi').expect(409);
    expect(res.body).toMatchObject({ code: 'BUSINESS_SELECTION_REQUIRED' });
  });

  // --- (9) tenant / membership status ---------------------------------

  it('(9) a SUSPENDED tenant can never become the active context', async () => {
    await me('c-only', TENANT_C).expect(403);
    await me('c-only').expect(403);
    await me('a-plus-c', TENANT_C).expect(403);
    // With no selection, the only ENTERABLE business is chosen.
    const res = await me('a-plus-c').expect(200);
    expect((res.body as InternalMeResponse).business.id).toBe(TENANT_A);
  });

  it('a SUSPENDED membership cannot be selected, even though the business itself is active', async () => {
    await me('a-plus-suspended-b', TENANT_B).expect(403);
    const res = await me('a-plus-suspended-b').expect(200);
    expect((res.body as InternalMeResponse).business.id).toBe(TENANT_A);
  });

  // --- (10)/(11) business list -----------------------------------------

  it('(10) the business list returns exactly the businesses each identity may enter', async () => {
    const list = async (key: string) =>
      (
        (await businesses(key).expect(200)).body as InternalBusinessesResponse
      ).businesses
        .map((b) => b.id)
        .sort();

    expect(await list('a-only')).toEqual([TENANT_A]);
    expect(await list('b-only')).toEqual([TENANT_B]);
    expect(await list('multi')).toEqual([TENANT_A, TENANT_B].sort());
    expect(await list('a-plus-c')).toEqual([TENANT_A]);
    expect(await list('a-plus-suspended-b')).toEqual([TENANT_A]);
  });

  it('(11) the business list leaks nothing else: safe fields only, 403 with no business, 401 without a token', async () => {
    const res = await businesses('multi').expect(200);
    for (const business of (res.body as InternalBusinessesResponse)
      .businesses) {
      expect(Object.keys(business).sort()).toEqual(['id', 'name', 'slug']);
    }
    expect(JSON.stringify(res.body)).not.toContain(TENANT_C);

    await businesses('c-only').expect(403);
    await businesses(`nobody-${randomUUID()}`).expect(403);
    await http().get('/api/v1/internal/businesses').expect(401);
  });

  it('a business provisioned by email becomes enterable for the same verified human, and binds on first use', async () => {
    const list = (await businesses('invitee').expect(200))
      .body as InternalBusinessesResponse;
    expect(list.businesses.map((b) => b.id).sort()).toEqual(
      [TENANT_A, TENANT_B].sort(),
    );

    const res = await me('invitee', TENANT_B).expect(200);
    expect((res.body as InternalMeResponse).business.id).toBe(TENANT_B);
    const rowB = await prisma.internalUser.findUniqueOrThrow({
      where: {
        tenantId_email: { tenantId: TENANT_B, email: emailOf('invitee') },
      },
    });
    expect(rowB.externalSubject).toBe(subjectOf('invitee'));
  });

  // --- (12) location context across a business switch ------------------

  it('(12) after switching to Tenant B, a Tenant A location is never authoritative', async () => {
    const asB = (path: string) =>
      http()
        .get(path)
        .set('Authorization', `Bearer ${token('multi')}`)
        .set('X-Tenant-Id', TENANT_B);

    // The shell's location source offers only the active business's
    // locations.
    const meB = (await me('multi', TENANT_B).expect(200))
      .body as InternalMeResponse;
    const offered = meB.authorization.locations.map((l) => l.id);
    expect(offered).toContain(locB);
    expect(offered).not.toContain(locA);
    const meA = (await me('multi', TENANT_A).expect(200))
      .body as InternalMeResponse;
    expect(meA.authorization.locations.map((l) => l.id)).toContain(locA);
    expect(meA.authorization.locations.map((l) => l.id)).not.toContain(locB);

    // A stale Tenant A location id sent while Tenant B is active is refused
    // before any read — even under B's CORPORATE grant.
    await asB(`/api/v1/admin/locations/${locA}`).expect(403);
    await asB(`/api/v1/admin/locations/${locB}`).expect(200);

    const listB = await asB('/api/v1/admin/locations').expect(200);
    const listedB = (listB.body as Array<{ id: string }>).map((l) => l.id);
    expect(listedB).toContain(locB);
    expect(listedB).not.toContain(locA);
  });

  it('a Tenant B CORPORATE admin cannot write a Tenant A location by id', async () => {
    const before = await prisma.location.findUniqueOrThrow({
      where: { id: locA },
    });
    await http()
      .patch(`/api/v1/admin/locations/${locA}`)
      .set('Authorization', `Bearer ${token('b-only')}`)
      .send({ name: 'hijacked' })
      .expect(404);
    await http()
      .patch(`/api/v1/admin/locations/${locA}/digital-ordering`)
      .set('Authorization', `Bearer ${token('b-only')}`)
      .send({ isDigitalOrderingEnabled: !before.isDigitalOrderingEnabled })
      .expect(403);
    const after = await prisma.location.findUniqueOrThrow({
      where: { id: locA },
    });
    expect(after.name).toBe(before.name);
    expect(after.isDigitalOrderingEnabled).toBe(
      before.isDigitalOrderingEnabled,
    );
  });

  // --- (13) existing Mocha House administrator -------------------------

  it('(13) the seeded Mocha House administrator still resolves Tenant A with no selection', async () => {
    const seeded = await prisma.internalUser.findUnique({
      where: {
        tenantId_email: { tenantId: TENANT_A, email: 'admin@mochahouse.test' },
      },
    });
    // The local seed provisions this user; skip quietly on a database that
    // was never seeded rather than inventing one here.
    if (!seeded || seeded.status !== 'ACTIVE' || !seeded.externalSubject) {
      return;
    }
    const seededToken = signInternalDevJwt(
      {
        sub: seeded.externalSubject,
        email: seeded.email,
        name: null,
      },
      internalSecret,
      3600,
    );
    const res = await http()
      .get('/api/v1/internal/me')
      .set('Authorization', `Bearer ${seededToken}`)
      .expect(200);
    expect((res.body as InternalMeResponse).business.id).toBe(TENANT_A);
    expect((res.body as InternalMeResponse).user.id).toBe(seeded.id);
  });

  // --- schema: one membership per (tenant, verified identity) ----------

  it('the same verified identity may be bound in two tenants, but never twice in one', async () => {
    const key = `dup-${randomUUID()}`;
    await member(key, TENANT_A);
    await member(key, TENANT_B);

    await expect(
      prisma.internalUser.create({
        data: {
          tenantId: TENANT_A,
          externalProvider: 'internal-dev',
          externalSubject: subjectOf(key),
          email: `other-${emailOf(key)}`,
          status: 'ACTIVE',
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  // --- (16)/(17) SINGLE_TENANT_ID is not admin authority ---------------

  it('(16) SINGLE_TENANT_ID has no say in an admin request; (17) public requests still use it', async () => {
    // Re-boot the API as if the deployment were configured for Tenant B.
    const original = process.env.SINGLE_TENANT_ID;
    process.env.SINGLE_TENANT_ID = TENANT_B;
    const tenantBDeployment = await compileApp();
    try {
      const server = () => request(tenantBDeployment.getHttpServer());

      // The A-only admin is still in A — the deployment tenant is ignored.
      const meRes = await server()
        .get('/api/v1/internal/me')
        .set('Authorization', `Bearer ${token('a-only')}`)
        .expect(200);
      expect((meRes.body as InternalMeResponse).business.id).toBe(TENANT_A);

      // ...and cannot be pushed into it either.
      await server()
        .get('/api/v1/internal/me')
        .set('Authorization', `Bearer ${token('a-only')}`)
        .set('X-Tenant-Id', TENANT_B)
        .expect(403);

      // Public (non-member) routes keep the transitional S0C behaviour.
      const publicRes = await server().get('/s0f-public-probe').expect(200);
      expect(
        (publicRes.body as { context: TenantContext }).context,
      ).toMatchObject({ tenantId: TENANT_B, principalType: 'anonymous' });
    } finally {
      await tenantBDeployment.close();
      process.env.SINGLE_TENANT_ID = original;
    }

    // In the normal deployment, a public route is Tenant #1, anonymous.
    const publicRes = await http().get('/s0f-public-probe').expect(200);
    expect(
      (publicRes.body as { context: TenantContext }).context,
    ).toMatchObject({ tenantId: TENANT_A, principalType: 'anonymous' });
  });
});
