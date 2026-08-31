import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { AdminAuditEventPage } from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { InternalUsersModule } from '../internal-users/internal-users.module';
import { AdminAuditModule } from './admin-audit.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { signDevJwt } from '../customer-auth/infrastructure/dev-jwt';

type Status = 'INVITED' | 'ACTIVE' | 'SUSPENDED' | 'DISABLED';

// Administration → Activity log (Milestone 5F): the read-only, business-
// facing projection of InternalAuditEvent, over real local Postgres.
describe('Admin activity log (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  const originalEnv = { ...process.env };
  const internalSecret = 'admin-audit-spec-internal-secret';
  const customerSecret = 'admin-audit-spec-customer-secret';
  const suffix = randomUUID();

  let locA: string;
  const userIds: string[] = [];
  const roleIds: string[] = [];
  const eventIds: string[] = [];

  const roles: Record<string, string> = {};
  const users: Record<string, string> = {};

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

  async function makeUser(
    key: string,
    status: Status,
    displayName: string | null = key,
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
    userIds.push(user.id);
    users[key] = user.id;
    return user.id;
  }

  async function makeRole(
    displayName: string,
    permissionKeys: string[],
  ): Promise<string> {
    const role = await prisma.internalRole.create({
      data: {
        key: `audit-spec-${suffix}-${randomUUID()}`,
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

  async function makeEvent(input: {
    action: string;
    actorId: string;
    targetId: string;
    reason?: string;
    beforeData?: Record<string, unknown>;
    afterData?: Record<string, unknown>;
  }): Promise<string> {
    const event = await prisma.internalAuditEvent.create({
      data: {
        actorInternalUserId: input.actorId,
        action: input.action,
        targetType: 'internal_user',
        targetId: input.targetId,
        beforeData: (input.beforeData ?? {}) as object,
        afterData: (input.afterData ?? {}) as object,
        reason: input.reason ?? 'spec reason',
      },
    });
    eventIds.push(event.id);
    return event.id;
  }

  const list = (actorKey: string, qs = '') =>
    request(app.getHttpServer())
      .get(`/api/v1/admin/audit${qs}`)
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
        AdminAuditModule,
      ],
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);

    locA = (
      await prisma.location.create({
        data: {
          name: `Audit Spec Loc ${suffix}`,
          slug: `audit-loc-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;

    roles.auditView = await makeRole('Audit Viewer', ['audit.view']);
    roles.noAudit = await makeRole('Orders Only', ['orders.view']);
    roles.platformAdmin = (
      await prisma.internalRole.findUniqueOrThrow({
        where: { key: 'platform-administrator' },
      })
    ).id;

    await makeUser(`viewer-${suffix}`, 'ACTIVE', 'Corporate Viewer');
    await assign(users[`viewer-${suffix}`], roles.auditView, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await makeUser(`locViewer-${suffix}`, 'ACTIVE');
    await assign(users[`locViewer-${suffix}`], roles.auditView, {
      scopeType: 'LOCATION',
      scopeId: locA,
    });

    await makeUser(`noPerm-${suffix}`, 'ACTIVE');
    await assign(users[`noPerm-${suffix}`], roles.noAudit, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await makeUser(`suspended-${suffix}`, 'SUSPENDED');
    await assign(users[`suspended-${suffix}`], roles.auditView, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await makeUser(`disabled-${suffix}`, 'DISABLED');
    await assign(users[`disabled-${suffix}`], roles.auditView, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    // Actors + subjects for the event fixtures.
    await makeUser(`nasser-${suffix}`, 'ACTIVE', 'Nasser');
    await makeUser(`sarah-${suffix}`, 'ACTIVE', 'Sarah');
    await makeUser(`noname-${suffix}`, 'ACTIVE', null); // displayName null
  }, 45_000);

  afterAll(async () => {
    await prisma.internalAuditEvent.deleteMany({
      where: {
        OR: [
          { id: { in: eventIds } },
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
    await prisma.location.deleteMany({ where: { id: locA } });
    await app.close();
    process.env = { ...originalEnv };
  });

  // ---- Authorization (1-6) --------------------------------------

  it('audit.view @ CORPORATE returns 200 (1)', async () => {
    await list(`viewer-${suffix}`).expect(200);
  });

  it('missing audit.view returns 403 (2)', async () => {
    await list(`noPerm-${suffix}`).expect(403);
  });

  it('a LOCATION-only audit.view grant cannot satisfy the CORPORATE-only route (3)', async () => {
    await list(`locViewer-${suffix}`).expect(403);
  });

  it('a customer token is rejected 401 (4)', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/audit')
      .set('Authorization', `Bearer ${customerToken()}`)
      .expect(401);
  });

  it('a SUSPENDED internal user is blocked 403 (5)', async () => {
    await list(`suspended-${suffix}`).expect(403);
  });

  it('a DISABLED internal user is blocked 403 (6)', async () => {
    await list(`disabled-${suffix}`).expect(403);
  });

  // ---- Read + pagination (7-19) --------------------------------

  describe('read + pagination', () => {
    // A dedicated actor whose events are the only ones this block filters to
    // (via the "performed by" filter), so the seeded/other rows don't
    // interfere.
    let pageActor: string;
    let pageSubject: string;
    const created: string[] = [];

    beforeAll(async () => {
      pageActor = await makeUser(`pager-${suffix}`, 'ACTIVE', 'Pager Person');
      pageSubject = users[`sarah-${suffix}`];
      for (let i = 0; i < 60; i++) {
        created.push(
          await makeEvent({
            action: 'user.status_changed',
            actorId: pageActor,
            targetId: pageSubject,
            reason: `bulk ${i}`,
            beforeData: { status: 'ACTIVE' },
            afterData: { status: i % 2 === 0 ? 'SUSPENDED' : 'ACTIVE' },
          }),
        );
      }
    });

    const mine = (qs = '') =>
      list(`viewer-${suffix}`, `?actor=Pager Person${qs}`);

    it('an empty result set returns events: [] and nextCursor: null (7)', async () => {
      const res = await list(
        `viewer-${suffix}`,
        `?actor=nobody-matches-${suffix}`,
      ).expect(200);
      expect(res.body).toEqual({ events: [], nextCursor: null });
    });

    it('newest first (8)', async () => {
      const res = await mine().expect(200);
      const body = res.body as AdminAuditEventPage;
      const times = body.events.map((e) => Date.parse(e.occurredAt));
      const ids = body.events.map((e) => e.id);
      expect([...times]).toEqual([...times].sort((a, b) => b - a));
      expect([...ids]).toEqual([...ids].sort().reverse());
    });

    it('page size is 25 and nextCursor is present when older rows exist (9,10)', async () => {
      const res = await mine().expect(200);
      const body = res.body as AdminAuditEventPage;
      expect(body.events).toHaveLength(25);
      expect(body.nextCursor).toBe(body.events[24].id);
    });

    it('the next page begins after the cursor with no duplicates or gaps (11,12)', async () => {
      const p1 = (await mine().expect(200)).body as AdminAuditEventPage;
      const p2 = (
        await mine(`&cursor=${p1.nextCursor}`).expect(200)
      ).body as AdminAuditEventPage;
      const p3 = (
        await mine(`&cursor=${p2.nextCursor}`).expect(200)
      ).body as AdminAuditEventPage;

      expect(p2.events).toHaveLength(25);
      expect(p3.events).toHaveLength(10); // 60 total - 50
      expect(p3.nextCursor).toBeNull();

      const all = [...p1.events, ...p2.events, ...p3.events].map((e) => e.id);
      expect(new Set(all).size).toBe(60);
      // strictly descending across the whole walk
      expect([...all]).toEqual([...all].sort().reverse());
    });

    it('a newer insert does not corrupt an in-progress pagination (13)', async () => {
      const p1 = (await mine().expect(200)).body as AdminAuditEventPage;
      // A brand-new event (higher UUIDv7 than the cursor).
      await makeEvent({
        action: 'user.status_changed',
        actorId: pageActor,
        targetId: pageSubject,
        reason: 'inserted mid-paging',
        beforeData: { status: 'ACTIVE' },
        afterData: { status: 'DISABLED' },
      });
      const p2 = (
        await mine(`&cursor=${p1.nextCursor}`).expect(200)
      ).body as AdminAuditEventPage;
      // page 2 is unchanged — it still contains only rows older than the
      // cursor, and none of page 1's rows.
      const p1ids = new Set(p1.events.map((e) => e.id));
      expect(p2.events.some((e) => p1ids.has(e.id))).toBe(false);
      expect(p2.events).toHaveLength(25);
    });

    it('a syntactically invalid cursor returns 400 (14)', async () => {
      await mine('&cursor=not-a-uuid').expect(400);
      await mine('&cursor=12345').expect(400);
    });

    it('a syntactically valid cursor that matches no event is a boundary value (14)', async () => {
      // All-zero UUID: lexicographically the smallest → nothing is older.
      const res = await mine(
        '&cursor=00000000-0000-0000-0000-000000000000',
      ).expect(200);
      expect((res.body as AdminAuditEventPage).events).toHaveLength(0);
      // All-f UUID: lexicographically the largest → everything is older.
      const res2 = await mine(
        '&cursor=ffffffff-ffff-ffff-ffff-ffffffffffff',
      ).expect(200);
      expect((res2.body as AdminAuditEventPage).events).toHaveLength(25);
    });
  });

  it('actor displayName is used, email is the fallback (15,16)', async () => {
    await makeEvent({
      action: 'user.status_changed',
      actorId: users[`nasser-${suffix}`],
      targetId: users[`sarah-${suffix}`],
      reason: 'named actor',
      beforeData: { status: 'ACTIVE' },
      afterData: { status: 'SUSPENDED' },
    });
    await makeEvent({
      action: 'user.status_changed',
      actorId: users[`noname-${suffix}`],
      targetId: users[`sarah-${suffix}`],
      reason: 'nameless actor',
      beforeData: { status: 'ACTIVE' },
      afterData: { status: 'SUSPENDED' },
    });
    const res = await list(`viewer-${suffix}`, '?actor=named actor').expect(200);
    // no match on reason — actor filter is name/email only
    expect((res.body as AdminAuditEventPage).events).toHaveLength(0);

    const named = (
      await list(`viewer-${suffix}`, '?actor=Nasser').expect(200)
    ).body as AdminAuditEventPage;
    expect(named.events[0].actor.name).toBe('Nasser');

    const nameless = (
      await list(
        `viewer-${suffix}`,
        `?actor=noname-${suffix}@example.com`,
      ).expect(200)
    ).body as AdminAuditEventPage;
    expect(nameless.events[0].actor.name).toBe(`noname-${suffix}@example.com`);
  });

  it('target displayName is used, email is the fallback, missing target is generic (17,18,19)', async () => {
    const ghostId = randomUUID();
    await makeEvent({
      action: 'user.status_changed',
      actorId: users[`nasser-${suffix}`],
      targetId: users[`noname-${suffix}`],
      reason: `t17-${suffix}`,
      beforeData: { status: 'ACTIVE' },
      afterData: { status: 'SUSPENDED' },
    });
    await makeEvent({
      action: 'user.status_changed',
      actorId: users[`nasser-${suffix}`],
      targetId: ghostId,
      reason: `t19-${suffix}`,
      beforeData: { status: 'ACTIVE' },
      afterData: { status: 'SUSPENDED' },
    });

    const named = (
      await list(`viewer-${suffix}`, '?actor=Nasser&type=admin_access_status_changed').expect(200)
    ).body as AdminAuditEventPage;
    const withSarah = named.events.find((e) => e.reason === 'named actor');
    expect(withSarah?.subject.label).toBe('Sarah');
    const withNoname = named.events.find((e) => e.reason === `t17-${suffix}`);
    expect(withNoname?.subject.label).toBe(`noname-${suffix}@example.com`);
    const withGhost = named.events.find((e) => e.reason === `t19-${suffix}`);
    expect(withGhost?.subject.label).toBe('an Admin user');
    expect(JSON.stringify(named)).not.toContain(ghostId);
  });

  // ---- Presentation (20-32) -----------------------------------

  describe('presentation', () => {
    let actor: string;
    let subject: string;

    beforeAll(async () => {
      actor = await makeUser(`presenter-${suffix}`, 'ACTIVE', 'Nasser Presenter');
      subject = await makeUser(`subject-${suffix}`, 'ACTIVE', 'Sarah Subject');
    });

    const only = (reason: string) =>
      list(`viewer-${suffix}`, `?actor=Nasser Presenter`).then((res) => {
        const body = res.body as AdminAuditEventPage;
        return body.events.find((e) => e.reason === reason)!;
      });

    it('ACTIVE -> SUSPENDED reads "suspended … Admin access" with friendly details (20,23)', async () => {
      await makeEvent({
        action: 'user.status_changed',
        actorId: actor,
        targetId: subject,
        reason: `p-susp-${suffix}`,
        beforeData: { status: 'ACTIVE' },
        afterData: { status: 'SUSPENDED' },
      });
      const e = await only(`p-susp-${suffix}`);
      expect(e.activityType).toBe('admin_access_status_changed');
      expect(e.activityLabel).toBe(
        "Nasser Presenter suspended Sarah Subject's Admin access",
      );
      expect(e.details).toEqual([
        { label: 'Previous access state', value: 'Active' },
        { label: 'New access state', value: 'Suspended' },
      ]);
    });

    it('SUSPENDED -> ACTIVE reads "reactivated" (21)', async () => {
      await makeEvent({
        action: 'user.status_changed',
        actorId: actor,
        targetId: subject,
        reason: `p-react-${suffix}`,
        beforeData: { status: 'SUSPENDED' },
        afterData: { status: 'ACTIVE' },
      });
      const e = await only(`p-react-${suffix}`);
      expect(e.activityLabel).toBe(
        "Nasser Presenter reactivated Sarah Subject's Admin access",
      );
    });

    it('ACTIVE -> DISABLED reads "disabled" (22)', async () => {
      await makeEvent({
        action: 'user.status_changed',
        actorId: actor,
        targetId: subject,
        reason: `p-dis-${suffix}`,
        beforeData: { status: 'ACTIVE' },
        afterData: { status: 'DISABLED' },
      });
      const e = await only(`p-dis-${suffix}`);
      expect(e.activityLabel).toBe(
        "Nasser Presenter disabled Sarah Subject's Admin access",
      );
    });

    it('location role assignment sentence + snapshot use (24,28,29)', async () => {
      const snapshotRoleId = randomUUID();
      const snapshotLocationId = randomUUID();
      await makeEvent({
        action: 'user.role_assigned',
        actorId: actor,
        targetId: subject,
        reason: `p-grant-loc-${suffix}`,
        beforeData: { assignment: null },
        afterData: {
          assignment: {
            roleId: snapshotRoleId,
            roleDisplayName: 'Store Manager',
            scope: 'LOCATION',
            locationId: snapshotLocationId,
            locationName: 'Dearborn Heights',
          },
        },
      });
      const e = await only(`p-grant-loc-${suffix}`);
      expect(e.activityType).toBe('admin_access_granted');
      expect(e.activityLabel).toBe(
        'Nasser Presenter gave Sarah Subject Store Manager access for Dearborn Heights',
      );
      expect(e.location).toEqual({ name: 'Dearborn Heights' });
      // the snapshotted role/location NAMES are used; the snapshotted ids
      // never surface
      expect(JSON.stringify(e)).not.toContain(snapshotRoleId);
      expect(JSON.stringify(e)).not.toContain(snapshotLocationId);
    });

    it('corporate role assignment sentence (25)', async () => {
      await makeEvent({
        action: 'user.role_assigned',
        actorId: actor,
        targetId: subject,
        reason: `p-grant-corp-${suffix}`,
        beforeData: { assignment: null },
        afterData: {
          assignment: {
            roleId: randomUUID(),
            roleDisplayName: 'Platform Administrator',
            scope: 'CORPORATE',
          },
        },
      });
      const e = await only(`p-grant-corp-${suffix}`);
      expect(e.activityLabel).toBe(
        'Nasser Presenter gave Sarah Subject Platform Administrator access for all locations',
      );
      expect(e.location).toBeNull();
    });

    it('location role removal sentence (26)', async () => {
      await makeEvent({
        action: 'user.role_removed',
        actorId: actor,
        targetId: subject,
        reason: `p-remove-loc-${suffix}`,
        beforeData: {
          assignment: {
            roleId: randomUUID(),
            roleDisplayName: 'Store Manager',
            scope: 'LOCATION',
            locationId: randomUUID(),
            locationName: 'Ann Arbor',
          },
        },
        afterData: { assignment: null },
      });
      const e = await only(`p-remove-loc-${suffix}`);
      expect(e.activityType).toBe('admin_access_removed');
      expect(e.activityLabel).toBe(
        "Nasser Presenter removed Sarah Subject's Store Manager access for Ann Arbor",
      );
    });

    it('corporate role removal sentence (27)', async () => {
      await makeEvent({
        action: 'user.role_removed',
        actorId: actor,
        targetId: subject,
        reason: `p-remove-corp-${suffix}`,
        beforeData: {
          assignment: {
            roleId: randomUUID(),
            roleDisplayName: 'Platform Administrator',
            scope: 'CORPORATE',
          },
        },
        afterData: { assignment: null },
      });
      const e = await only(`p-remove-corp-${suffix}`);
      expect(e.activityLabel).toBe(
        "Nasser Presenter removed Sarah Subject's Platform Administrator access for all locations",
      );
    });

    it('an unsupported action gets a safe generic projection, no raw action string (30,32)', async () => {
      await makeEvent({
        action: 'catalog.product.updated',
        actorId: actor,
        targetId: subject,
        reason: `p-unknown-${suffix}`,
        beforeData: { productName: 'Old Latte' },
        afterData: { productName: 'New Latte' },
      });
      const e = await only(`p-unknown-${suffix}`);
      expect(e.activityType).toBe('other');
      expect(e.activityLabel).toBe(
        'Nasser Presenter made an administrative change',
      );
      expect(e.details).toEqual([]);
      expect(JSON.stringify(e)).not.toContain('catalog.product.updated');
      expect(JSON.stringify(e)).not.toContain('Old Latte');
      expect(JSON.stringify(e)).not.toContain('New Latte');
    });

    it('a known action with a malformed payload gets a safe generic projection (31)', async () => {
      await makeEvent({
        action: 'user.role_assigned',
        actorId: actor,
        targetId: subject,
        reason: `p-malformed-${suffix}`,
        beforeData: { assignment: null },
        afterData: { assignment: 'totally wrong shape' },
      });
      const e = await only(`p-malformed-${suffix}`);
      expect(e.activityType).toBe('other');
      expect(e.activityLabel).toBe(
        'Nasser Presenter made an administrative change',
      );
    });
  });

  // ---- Filters (33-47) ---------------------------------------

  describe('filters', () => {
    let fActor: string;
    let fSubject: string;

    beforeAll(async () => {
      fActor = await makeUser(`filterer-${suffix}`, 'ACTIVE', 'Filter Actor');
      fSubject = users[`sarah-${suffix}`];
      await makeEvent({
        action: 'user.status_changed',
        actorId: fActor,
        targetId: fSubject,
        reason: `f-status-${suffix}`,
        beforeData: { status: 'ACTIVE' },
        afterData: { status: 'SUSPENDED' },
      });
      await makeEvent({
        action: 'user.role_assigned',
        actorId: fActor,
        targetId: fSubject,
        reason: `f-grant-${suffix}`,
        beforeData: { assignment: null },
        afterData: {
          assignment: {
            roleId: randomUUID(),
            roleDisplayName: 'Store Manager',
            scope: 'CORPORATE',
          },
        },
      });
      await makeEvent({
        action: 'user.role_removed',
        actorId: fActor,
        targetId: fSubject,
        reason: `f-remove-${suffix}`,
        beforeData: {
          assignment: {
            roleId: randomUUID(),
            roleDisplayName: 'Store Manager',
            scope: 'CORPORATE',
          },
        },
        afterData: { assignment: null },
      });
    });

    const f = (qs: string) => list(`viewer-${suffix}`, `?actor=Filter Actor${qs}`);

    it('type=admin_access_status_changed returns only status events (33)', async () => {
      const body = (
        await f('&type=admin_access_status_changed').expect(200)
      ).body as AdminAuditEventPage;
      expect(body.events.map((e) => e.activityType)).toEqual([
        'admin_access_status_changed',
      ]);
    });

    it('type=admin_access_granted returns only grant events (34)', async () => {
      const body = (await f('&type=admin_access_granted').expect(200))
        .body as AdminAuditEventPage;
      expect(body.events.map((e) => e.activityType)).toEqual([
        'admin_access_granted',
      ]);
    });

    it('type=admin_access_removed returns only removal events (35)', async () => {
      const body = (await f('&type=admin_access_removed').expect(200))
        .body as AdminAuditEventPage;
      expect(body.events.map((e) => e.activityType)).toEqual([
        'admin_access_removed',
      ]);
    });

    it('an unknown business type is rejected 400 (36)', async () => {
      await f('&type=user.role_assigned').expect(400);
      await f('&type=whatever').expect(400);
    });

    it('from / to / from+to bound the results inclusively (37,38,39)', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const tomorrow = new Date(Date.now() + 86_400_000)
        .toISOString()
        .slice(0, 10);
      const yesterday = new Date(Date.now() - 86_400_000)
        .toISOString()
        .slice(0, 10);

      // events created "just now" are within [yesterday, tomorrow] and
      // within from=today (bare date widened to start of day)
      expect(
        ((await f(`&from=${today}`).expect(200)).body as AdminAuditEventPage)
          .events.length,
      ).toBeGreaterThanOrEqual(3);
      expect(
        ((await f(`&to=${today}`).expect(200)).body as AdminAuditEventPage)
          .events.length,
      ).toBeGreaterThanOrEqual(3);
      expect(
        (
          (await f(`&from=${yesterday}&to=${tomorrow}`).expect(200))
            .body as AdminAuditEventPage
        ).events.length,
      ).toBeGreaterThanOrEqual(3);
      // a window entirely in the past excludes them
      expect(
        (
          (
            await f(
              `&from=2000-01-01&to=2000-01-02`,
            ).expect(200)
          ).body as AdminAuditEventPage
        ).events,
      ).toHaveLength(0);
    });

    it('from > to is rejected 400 (40)', async () => {
      await f('&from=2026-02-01&to=2026-01-01').expect(400);
    });

    it('a malformed date is rejected 400 (41)', async () => {
      await f('&from=not-a-date').expect(400);
      await f('&to=2026-13-45').expect(400);
    });

    it('actor search matches displayName and email, case-insensitively, trimmed (42,43,44,45)', async () => {
      expect(
        (
          (await list(`viewer-${suffix}`, '?actor=filter actor').expect(200))
            .body as AdminAuditEventPage
        ).events.length,
      ).toBeGreaterThanOrEqual(3);
      expect(
        (
          (
            await list(
              `viewer-${suffix}`,
              `?actor=${encodeURIComponent(`  FILTERER-${suffix}@EXAMPLE.COM  `)}`,
            ).expect(200)
          ).body as AdminAuditEventPage
        ).events.length,
      ).toBeGreaterThanOrEqual(3);
      // blank after trim → treated as absent (returns the whole log, not zero)
      const blank = (
        await list(`viewer-${suffix}`, '?actor=%20%20').expect(200)
      ).body as AdminAuditEventPage;
      expect(blank.events.length).toBeGreaterThan(0);
    });

    it('an over-long actor search is rejected 400 (46)', async () => {
      await list(
        `viewer-${suffix}`,
        `?actor=${'x'.repeat(101)}`,
      ).expect(400);
    });

    it('filters compose with the cursor (47)', async () => {
      const p1 = (
        await list(
          `viewer-${suffix}`,
          `?actor=Pager Person&type=admin_access_status_changed`,
        ).expect(200)
      ).body as AdminAuditEventPage;
      expect(p1.events).toHaveLength(25);
      expect(p1.events.every((e) => e.activityType === 'admin_access_status_changed')).toBe(
        true,
      );
      const p2 = (
        await list(
          `viewer-${suffix}`,
          `?actor=Pager Person&type=admin_access_status_changed&cursor=${p1.nextCursor}`,
        ).expect(200)
      ).body as AdminAuditEventPage;
      const p1ids = new Set(p1.events.map((e) => e.id));
      expect(p2.events.some((e) => p1ids.has(e.id))).toBe(false);
      expect(p2.events.every((e) => e.activityType === 'admin_access_status_changed')).toBe(
        true,
      );
    });
  });

  // ---- Privacy / projection (48-55) --------------------------

  it('the response never exposes raw internals (48-55)', async () => {
    const tokenLike = `secret-token-${randomUUID()}`;
    await makeEvent({
      action: 'user.role_assigned',
      actorId: users[`nasser-${suffix}`],
      targetId: users[`sarah-${suffix}`],
      reason: `privacy-${suffix}`,
      beforeData: { assignment: null, internalToken: tokenLike },
      afterData: {
        assignment: {
          roleId: 'role-uuid-here',
          roleDisplayName: 'Store Manager',
          scope: 'LOCATION',
          locationId: 'loc-uuid-here',
          locationName: 'Somewhere',
        },
        provider: { subject: tokenLike },
      },
    });
    const res = await list(
      `viewer-${suffix}`,
      `?actor=Nasser&type=admin_access_granted`,
    ).expect(200);
    const raw = JSON.stringify(res.body);
    for (const forbidden of [
      'beforeData',
      'afterData',
      'targetId',
      'targetType',
      'roleId',
      'locationId',
      '"scope"',
      'internalToken',
      'provider',
      tokenLike,
      'role-uuid-here',
      'loc-uuid-here',
      'user.role_assigned',
      'internal_user',
    ]) {
      expect(raw).not.toContain(forbidden);
    }
    // shape check: only the approved keys
    const event = (res.body as AdminAuditEventPage).events[0];
    expect(Object.keys(event).sort()).toEqual(
      [
        'actor',
        'activityLabel',
        'activityType',
        'details',
        'id',
        'location',
        'occurredAt',
        'reason',
        'subject',
      ].sort(),
    );
    expect(Object.keys(event.actor).sort()).toEqual(['email', 'id', 'name']);
    expect(Object.keys(event.subject).sort()).toEqual(['kind', 'label']);
  });

  // ---- Regression (56-60) ----------------------------------

  it('a real 5E status change still writes an audit event, and it appears in the log (56)', async () => {
    const admin = await makeUser(`regadmin-${suffix}`, 'ACTIVE', 'Reg Admin');
    await assign(admin, roles.platformAdmin, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    const target = await makeUser(`regtarget-${suffix}`, 'ACTIVE', 'Reg Target');
    // a second corporate admin so last-admin protection doesn't block
    const admin2 = await makeUser(`regadmin2-${suffix}`, 'ACTIVE', 'Reg Admin Two');
    await assign(admin2, roles.platformAdmin, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });

    await request(app.getHttpServer())
      .patch(`/api/v1/admin/internal-users/${target}/status`)
      .set('Authorization', `Bearer ${token(`regadmin-${suffix}`)}`)
      .send({ status: 'SUSPENDED', reason: 'reg check' })
      .expect(200);

    const evt = await prisma.internalAuditEvent.findFirst({
      where: { targetId: target, action: 'user.status_changed' },
    });
    expect(evt).not.toBeNull();
    if (evt) eventIds.push(evt.id);

    const log = (
      await list(`regadmin-${suffix}`, '?actor=Reg Admin&type=admin_access_status_changed').expect(200)
    ).body as AdminAuditEventPage;
    const row = log.events.find((e) => e.reason === 'reg check');
    expect(row?.activityLabel).toBe("Reg Admin suspended Reg Target's Admin access");
  });

  it('real 5E assignment + removal still write audit events (57,58)', async () => {
    const admin = users[`regadmin-${suffix}`];
    expect(admin).toBeTruthy();
    const target = await makeUser(`regassign-${suffix}`, 'ACTIVE', 'Reg Assignee');
    const storeManagerRoleId = (
      await prisma.internalRole.findUniqueOrThrow({
        where: { key: 'store-manager' },
      })
    ).id;

    const assignRes = await request(app.getHttpServer())
      .post(`/api/v1/admin/internal-users/${target}/role-assignments`)
      .set('Authorization', `Bearer ${token(`regadmin-${suffix}`)}`)
      .send({
        roleId: storeManagerRoleId,
        scope: { kind: 'locations', locationIds: [locA] },
        reason: 'reg assign',
      })
      .expect(201);

    const assignmentId = (assignRes.body as { assignments: { id: string }[] })
      .assignments[0].id;

    await request(app.getHttpServer())
      .post(
        `/api/v1/admin/internal-users/${target}/role-assignments/${assignmentId}/remove`,
      )
      .set('Authorization', `Bearer ${token(`regadmin-${suffix}`)}`)
      .send({ reason: 'reg remove' })
      .expect(201);

    const evts = await prisma.internalAuditEvent.findMany({
      where: { targetId: target },
      orderBy: { createdAt: 'asc' },
    });
    for (const e of evts) eventIds.push(e.id);
    expect(evts.map((e) => e.action)).toEqual([
      'user.role_assigned',
      'user.role_removed',
    ]);

    const log = (
      await list(`regadmin-${suffix}`, '?actor=Reg Admin').expect(200)
    ).body as AdminAuditEventPage;
    expect(log.events.find((e) => e.reason === 'reg assign')?.activityLabel).toBe(
      `Reg Admin gave Reg Assignee Store Manager access for Audit Spec Loc ${suffix}`,
    );
    expect(log.events.find((e) => e.reason === 'reg remove')?.activityLabel).toBe(
      `Reg Admin removed Reg Assignee's Store Manager access for Audit Spec Loc ${suffix}`,
    );
  });

  it('Store Manager does not gain audit.view; Platform Administrator does (59,60)', async () => {
    const sm = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'store-manager' },
      include: { permissions: true },
    });
    const pa = await prisma.internalRole.findUniqueOrThrow({
      where: { key: 'platform-administrator' },
      include: { permissions: true },
    });
    expect(sm.permissions.map((p) => p.permissionKey)).not.toContain('audit.view');
    expect(pa.permissions.map((p) => p.permissionKey)).toContain('audit.view');
  });
});
