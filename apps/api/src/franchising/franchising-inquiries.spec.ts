import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, type ExecutionContext } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminFranchiseInquiriesResponse,
  AdminFranchiseInquiryDetail,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { InternalAuditService } from '../audit/internal-audit.service';
import { RedisService } from '../redis/redis.service';
import { FranchisingModule } from './franchising.module';
import { FranchisingPublicThrottleGuard } from './infrastructure/franchising-public-throttle.guard';

// Milestone 8D — Franchising inquiries over real local Postgres, mirroring
// careers-applications.spec.ts (8C).
describe('Franchising / Inquiries (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let audit: InternalAuditService;
  let redis: RedisService;
  const originalEnv = { ...process.env };
  const internalSecret = 'franchising-spec-internal-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const inquiryIds: string[] = [];

  const users: Record<string, string> = {};
  const roles: Record<string, string> = {};
  let activeLocationId: string;

  const token = (key: string) =>
    signInternalDevJwt(
      { sub: `internal-dev:${key}`, email: `${key}@example.com`, name: null },
      internalSecret,
      3600,
    );

  async function makeUser(key: string): Promise<void> {
    const user = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:${key}`,
        email: `${key}@example.com`,
        displayName: key,
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    userIds.push(user.id);
    users[key] = user.id;
  }

  async function makeRole(name: string, keys: string[]): Promise<string> {
    const role = await prisma.internalRole.create({
      data: {
        key: `franchising-spec-${suffix}-${randomUUID()}`,
        displayName: name,
        permissions: {
          create: keys.map((permissionKey) => ({ permissionKey })),
        },
      },
    });
    roleIds.push(role.id);
    return role.id;
  }

  async function assign(
    key: string,
    roleId: string,
    scope: { scopeType: 'CORPORATE' | 'LOCATION'; scopeId: string | null },
  ): Promise<void> {
    await prisma.internalUserRoleAssignment.create({
      data: { internalUserId: users[key]!, roleId, ...scope },
    });
  }

  const adminReq = (method: 'get' | 'post', path: string, key: string) =>
    request(app.getHttpServer())
      [method](`/api/v1/admin/franchising/inquiries${path}`)
      .set('Authorization', `Bearer ${token(key)}`);

  const submit = (body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/v1/franchising/inquiries')
      .send(body);

  function inquiryBody(overrides: Record<string, unknown> = {}) {
    return {
      firstName: 'Jordan',
      lastName: 'Lee',
      email: `jordan-${randomUUID()}@example.com`,
      phone: '555-0100',
      city: 'Austin',
      state: 'TX',
      country: 'USA',
      preferredMarket: 'Central Texas',
      consentAcknowledged: true,
      ...overrides,
    };
  }

  async function seedInquiry(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = await prisma.franchiseInquiry.create({
      data: {
        firstName: 'Seed',
        lastName: 'Prospect',
        email: `seed-${randomUUID()}@example.com`,
        phone: '555-0000',
        city: 'Dallas',
        state: 'TX',
        country: 'USA',
        preferredMarket: 'North Texas',
        consentAcknowledged: true,
        ...overrides,
      },
    });
    inquiryIds.push(row.id);
    return row.id;
  }

  function throttleContext(ip: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({ ip, socket: { remoteAddress: ip } }),
      }),
    } as unknown as ExecutionContext;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';
    process.env.INTERNAL_AUTH_PROVIDER = 'dev';
    process.env.INTERNAL_AUTH_DEV_JWT_SECRET = internalSecret;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        FranchisingModule,
      ],
    })
      // Every supertest request shares one loopback IP, so the real ~5/min
      // Redis throttle would trip mid-suite. The guard's behaviour is
      // exercised directly against FranchisingPublicThrottleGuard below;
      // here it is a pass-through.
      .overrideGuard(FranchisingPublicThrottleGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    audit = moduleFixture.get(InternalAuditService);
    redis = moduleFixture.get(RedisService);

    activeLocationId = (
      await prisma.location.create({
        data: {
          name: `Franchising Active ${suffix}`,
          slug: `franchising-active-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;

    roles.viewer = await makeRole('Franchising Viewer', ['franchising.view']);
    roles.manager = await makeRole('Franchising Manager', [
      'franchising.view',
      'franchising.manage',
    ]);
    roles.none = await makeRole('Orders Only', ['orders.view']);

    await makeUser(`viewer-${suffix}`);
    await assign(`viewer-${suffix}`, roles.viewer, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUser(`manager-${suffix}`);
    await assign(`manager-${suffix}`, roles.manager, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUser(`noPerm-${suffix}`);
    await assign(`noPerm-${suffix}`, roles.none, {
      scopeType: 'CORPORATE',
      scopeId: null,
    });
    await makeUser(`locMgr-${suffix}`);
    await assign(`locMgr-${suffix}`, roles.manager, {
      scopeType: 'LOCATION',
      scopeId: activeLocationId,
    });
  });

  afterAll(async () => {
    await prisma.internalAuditEvent.deleteMany({
      where: { actorInternalUserId: { in: userIds } },
    });
    await prisma.franchiseInquiryNote.deleteMany({
      where: { franchiseInquiryId: { in: inquiryIds } },
    });
    await prisma.franchiseInquiry.deleteMany({
      where: {
        OR: [{ id: { in: inquiryIds } }, { preferredMarket: { contains: suffix } }],
      },
    });
    await prisma.internalUserRoleAssignment.deleteMany({
      where: { internalUserId: { in: userIds } },
    });
    await prisma.internalRolePermission.deleteMany({
      where: { roleId: { in: roleIds } },
    });
    await prisma.internalRole.deleteMany({ where: { id: { in: roleIds } } });
    await prisma.internalUser.deleteMany({ where: { id: { in: userIds } } });
    await prisma.location.deleteMany({ where: { id: activeLocationId } });
    await app.close();
    await prisma.$disconnect();
    process.env = { ...originalEnv };
  });

  // --- public submission -------------------------------------

  it('accepts an inquiry, stores it NEW, returns only { ok: true }', async () => {
    const body = inquiryBody({ preferredMarket: `Central Texas ${suffix}` });
    const res = await submit(body).expect(201);
    expect(res.body).toEqual({ ok: true });

    const row = await prisma.franchiseInquiry.findFirst({
      where: { email: body.email },
    });
    expect(row).not.toBeNull();
    inquiryIds.push(row!.id);
    expect(row!.status).toBe('NEW');
    expect(row!.consentAcknowledged).toBe(true);
    expect(row!.investmentRange).toBeNull();
    expect(row!.timeframe).toBeNull();
    expect(row!.businessExperience).toBeNull();
    expect(row!.message).toBeNull();
  });

  it('accepts the optional free-text fields untouched (no invented buckets)', async () => {
    const body = inquiryBody({
      preferredMarket: `Optional Fields ${suffix}`,
      investmentRange: 'Around $300k-$500k, flexible',
      timeframe: 'Within the next year',
      businessExperience: '10 years running retail locations',
      message: 'Excited to learn more.',
    });
    await submit(body).expect(201);
    const row = await prisma.franchiseInquiry.findFirst({
      where: { email: body.email },
    });
    inquiryIds.push(row!.id);
    expect(row!.investmentRange).toBe(body.investmentRange);
    expect(row!.timeframe).toBe(body.timeframe);
    expect(row!.businessExperience).toBe(body.businessExperience);
    expect(row!.message).toBe(body.message);
  });

  it('allows repeat submissions from the same email (no dedup)', async () => {
    const email = `repeat-${randomUUID()}@example.com`;
    await submit(inquiryBody({ email })).expect(201);
    await submit(inquiryBody({ email })).expect(201);
    const count = await prisma.franchiseInquiry.count({ where: { email } });
    expect(count).toBe(2);
    const rows = await prisma.franchiseInquiry.findMany({ where: { email } });
    inquiryIds.push(...rows.map((r) => r.id));
  });

  it('rejects missing/blank required fields', async () => {
    await submit(inquiryBody({ firstName: '   ' })).expect(400);
    await submit(inquiryBody({ lastName: '' })).expect(400);
    await submit(inquiryBody({ phone: undefined })).expect(400);
    await submit(inquiryBody({ city: undefined })).expect(400);
    await submit(inquiryBody({ state: undefined })).expect(400);
    await submit(inquiryBody({ country: undefined })).expect(400);
    await submit(inquiryBody({ preferredMarket: undefined })).expect(400);
  });

  it('rejects a bad email', async () => {
    await submit(inquiryBody({ email: 'nope' })).expect(400);
  });

  it('rejects consentAcknowledged false or missing', async () => {
    await submit(inquiryBody({ consentAcknowledged: false })).expect(400);
    await submit(inquiryBody({ consentAcknowledged: undefined })).expect(400);
    await submit(inquiryBody({ consentAcknowledged: 'yes' })).expect(400);
  });

  it('trims text and enforces maximum lengths', async () => {
    const body = inquiryBody({
      firstName: '  Jordan  ',
      preferredMarket: `  Trim Market ${suffix}  `,
    });
    await submit(body).expect(201);
    const row = await prisma.franchiseInquiry.findFirst({
      where: { email: body.email },
    });
    inquiryIds.push(row!.id);
    expect(row!.firstName).toBe('Jordan');
    expect(row!.preferredMarket).toBe(`Trim Market ${suffix}`);

    await submit(inquiryBody({ firstName: 'x'.repeat(200) })).expect(400);
    await submit(inquiryBody({ message: 'x'.repeat(5000) })).expect(400);
  });

  it('does not create an InternalAuditEvent for a public submission', async () => {
    const before = await prisma.internalAuditEvent.count();
    const body = inquiryBody({ preferredMarket: `No Audit ${suffix}` });
    await submit(body).expect(201);
    const row = await prisma.franchiseInquiry.findFirst({
      where: { email: body.email },
    });
    inquiryIds.push(row!.id);
    expect(await prisma.internalAuditEvent.count()).toBe(before);
  });

  it('has no public GET for an inquiry', async () => {
    const inquiryId = await seedInquiry();
    await request(app.getHttpServer())
      .get('/api/v1/franchising/inquiries')
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/franchising/inquiries/${inquiryId}`)
      .expect(404);
  });

  // --- public throttle (guard, direct) ----------------------

  it('throttles roughly 5 submissions / minute / IP and fails OPEN when Redis is down', async () => {
    const guard = new FranchisingPublicThrottleGuard(redis);
    const ip = `203.0.113.${Math.floor(Math.random() * 250) + 1}`;
    for (let i = 0; i < 5; i += 1) {
      await expect(guard.canActivate(throttleContext(ip))).resolves.toBe(true);
    }
    await expect(
      guard.canActivate(throttleContext(ip)),
    ).rejects.toMatchObject({ status: 429 });

    const spy = jest.spyOn(redis, 'getClient').mockImplementation(() => {
      throw new Error('redis down');
    });
    await expect(
      guard.canActivate(throttleContext('198.51.100.9')),
    ).resolves.toBe(true);
    spy.mockRestore();
  });

  // --- admin authorization ----------------------------------

  it('401 without a session; 403 without franchising.view; view cannot manage; LOCATION grant rejected', async () => {
    const inquiryId = await seedInquiry();

    await request(app.getHttpServer())
      .get('/api/v1/admin/franchising/inquiries')
      .expect(401);

    await adminReq('get', '', `noPerm-${suffix}`).expect(403);
    await adminReq('get', `/${inquiryId}`, `noPerm-${suffix}`).expect(403);

    // franchising.view alone cannot change status or add a note
    await adminReq('post', `/${inquiryId}/status`, `viewer-${suffix}`)
      .send({ status: 'REVIEWING' })
      .expect(403);
    await adminReq('post', `/${inquiryId}/notes`, `viewer-${suffix}`)
      .send({ body: 'nope' })
      .expect(403);

    // CORPORATE-only — a LOCATION-scoped manager is rejected
    await adminReq('get', '', `locMgr-${suffix}`).expect(403);
    await adminReq('post', `/${inquiryId}/status`, `locMgr-${suffix}`)
      .send({ status: 'REVIEWING' })
      .expect(403);
  });

  it('franchising.view can read', async () => {
    const inquiryId = await seedInquiry();
    await adminReq('get', '', `viewer-${suffix}`).expect(200);
    await adminReq('get', `/${inquiryId}`, `viewer-${suffix}`).expect(200);
  });

  // --- admin list ------------------------------------------

  it('lists newest-first with status filter and cursor pagination', async () => {
    const created: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      created.push(
        await seedInquiry({ preferredMarket: `List Market ${suffix}` }),
      );
    }
    const rejectedId = await seedInquiry({
      status: 'CLOSED',
      preferredMarket: `List Closed ${suffix}`,
    });

    const closed = (
      await adminReq('get', '?status=CLOSED', `viewer-${suffix}`).expect(200)
    ).body as AdminFranchiseInquiriesResponse;
    expect(closed.inquiries.map((i) => i.id)).toContain(rejectedId);
    expect(closed.inquiries.every((i) => i.status === 'CLOSED')).toBe(true);

    const page1 = (
      await adminReq(
        'get',
        `?cursor=${created[2]!}`,
        `viewer-${suffix}`,
      ).expect(200)
    ).body as AdminFranchiseInquiriesResponse;
    // cursor is the newest id in `created` -> the two older `created` rows
    // (plus whatever else already existed before them) come after it.
    const ids = page1.inquiries.map((i) => i.id);
    expect(ids).toContain(created[1]);
    expect(ids).toContain(created[0]);
    expect(ids).not.toContain(created[2]);

    await adminReq('get', '?status=BOGUS', `viewer-${suffix}`).expect(400);
  });

  // --- admin detail ---------------------------------------

  it('returns the full inquiry detail; 404 for an unknown id', async () => {
    const inquiryId = await seedInquiry({
      firstName: 'Priya',
      lastName: 'Anand',
      investmentRange: '$250k-$400k',
      timeframe: 'Next 6 months',
    });

    const detail = (
      await adminReq('get', `/${inquiryId}`, `viewer-${suffix}`).expect(200)
    ).body as AdminFranchiseInquiryDetail;
    expect(detail).toMatchObject({
      id: inquiryId,
      status: 'NEW',
      firstName: 'Priya',
      lastName: 'Anand',
      investmentRange: '$250k-$400k',
      timeframe: 'Next 6 months',
      consentAcknowledged: true,
    });
    expect(detail.notes).toEqual([]);
    expect(detail.activity).toEqual([]);

    await adminReq('get', `/${randomUUID()}`, `viewer-${suffix}`).expect(404);
  });

  // --- status changes -------------------------------------

  it('moves status freely between any valid values, rejects an invalid one, and audits atomically without PII', async () => {
    const inquiryId = await seedInquiry();

    await adminReq('post', `/${inquiryId}/status`, `manager-${suffix}`)
      .send({ status: 'QUALIFIED' })
      .expect(201);
    await adminReq('post', `/${inquiryId}/status`, `manager-${suffix}`)
      .send({ status: 'NEW' })
      .expect(201); // free backward movement, no transition graph
    await adminReq('post', `/${inquiryId}/status`, `manager-${suffix}`)
      .send({ status: 'BOGUS' })
      .expect(400);

    const row = await prisma.franchiseInquiry.findUnique({
      where: { id: inquiryId },
    });
    expect(row!.status).toBe('NEW');

    const events = await prisma.internalAuditEvent.findMany({
      where: {
        targetType: 'franchise_inquiry',
        targetId: inquiryId,
        action: 'franchising.inquiry_status_changed',
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(events).toHaveLength(2);
    expect(events[0]!.actorInternalUserId).toBe(users[`manager-${suffix}`]);
    expect(events[0]!.beforeData).toEqual({ status: 'NEW' });
    expect(events[0]!.afterData).toEqual({ status: 'QUALIFIED' });
    const blob = JSON.stringify(events);
    expect(blob).not.toContain(row!.email);
    expect(blob).not.toContain(row!.firstName);
    expect(blob).not.toContain(row!.preferredMarket);

    // atomicity — audit write fails, status is not persisted
    const spy = jest
      .spyOn(audit, 'recordFranchiseInquiryStatusChanged')
      .mockRejectedValueOnce(new Error('audit boom'));
    await adminReq('post', `/${inquiryId}/status`, `manager-${suffix}`)
      .send({ status: 'CLOSED' })
      .expect(500);
    spy.mockRestore();
    const after = await prisma.franchiseInquiry.findUnique({
      where: { id: inquiryId },
    });
    expect(after!.status).toBe('NEW');
  });

  it('a no-op status change (same value) succeeds and writes no audit event', async () => {
    const inquiryId = await seedInquiry();
    const before = await prisma.internalAuditEvent.count({
      where: { targetType: 'franchise_inquiry', targetId: inquiryId },
    });
    await adminReq('post', `/${inquiryId}/status`, `manager-${suffix}`)
      .send({ status: 'NEW' })
      .expect(201);
    expect(
      await prisma.internalAuditEvent.count({
        where: { targetType: 'franchise_inquiry', targetId: inquiryId },
      }),
    ).toBe(before);
  });

  // --- notes ---------------------------------------------

  it('adds append-only notes (newest first) with the author, audits atomically, never storing the body in the audit', async () => {
    const inquiryId = await seedInquiry();

    await adminReq('post', `/${inquiryId}/notes`, `manager-${suffix}`)
      .send({ body: '  first note  ' })
      .expect(201);
    const list = (
      await adminReq('post', `/${inquiryId}/notes`, `manager-${suffix}`)
        .send({ body: 'second note' })
        .expect(201)
    ).body as AdminFranchiseInquiryDetail['notes'];
    expect(list.map((n) => n.body)).toEqual(['second note', 'first note']);
    expect(list.every((n) => n.authorLabel === `manager-${suffix}`)).toBe(true);

    // validation
    await adminReq('post', `/${inquiryId}/notes`, `manager-${suffix}`)
      .send({ body: '   ' })
      .expect(400);
    await adminReq('post', `/${inquiryId}/notes`, `manager-${suffix}`)
      .send({ body: 'x'.repeat(2001) })
      .expect(400);

    const events = await prisma.internalAuditEvent.findMany({
      where: {
        targetType: 'franchise_inquiry',
        targetId: inquiryId,
        action: 'franchising.note_added',
      },
    });
    expect(events).toHaveLength(2);
    const blob = JSON.stringify(events);
    expect(blob).not.toContain('first note');
    expect(blob).not.toContain('second note');
    for (const e of events) {
      expect(e.afterData).toMatchObject({ noteLength: expect.any(Number) });
      expect(e.actorInternalUserId).toBe(users[`manager-${suffix}`]);
    }

    // atomicity — audit write fails, no note row persists
    const spy = jest
      .spyOn(audit, 'recordFranchiseInquiryNoteAdded')
      .mockRejectedValueOnce(new Error('audit boom'));
    await adminReq('post', `/${inquiryId}/notes`, `manager-${suffix}`)
      .send({ body: 'should not persist' })
      .expect(500);
    spy.mockRestore();
    expect(
      await prisma.franchiseInquiryNote.count({
        where: { franchiseInquiryId: inquiryId, body: 'should not persist' },
      }),
    ).toBe(0);
  });

  it('GET notes and detail activity reflect status changes and notes', async () => {
    const inquiryId = await seedInquiry();
    await adminReq('post', `/${inquiryId}/status`, `manager-${suffix}`)
      .send({ status: 'REVIEWING' })
      .expect(201);
    await adminReq('post', `/${inquiryId}/notes`, `manager-${suffix}`)
      .send({ body: 'called prospect' })
      .expect(201);

    const detail = (
      await adminReq('get', `/${inquiryId}`, `viewer-${suffix}`).expect(200)
    ).body as AdminFranchiseInquiryDetail;
    expect(detail.notes.map((n) => n.body)).toEqual(['called prospect']);
    const summaries = detail.activity.map((a) => a.summary);
    expect(summaries).toContain('Status changed from NEW to REVIEWING');
    expect(summaries).toContain('Internal note added');

    const notes = (
      await adminReq('get', `/${inquiryId}/notes`, `viewer-${suffix}`).expect(
        200,
      )
    ).body as AdminFranchiseInquiryDetail['notes'];
    expect(notes.map((n) => n.body)).toEqual(['called prospect']);
  });
});
