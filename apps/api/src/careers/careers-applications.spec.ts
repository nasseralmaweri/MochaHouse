import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, type ExecutionContext } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminJobApplicationDetail,
  AdminJobApplicationsResponse,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { InternalAuditService } from '../audit/internal-audit.service';
import { RedisService } from '../redis/redis.service';
import { CareersModule } from './careers.module';
import { CareersPublicThrottleGuard } from './infrastructure/careers-public-throttle.guard';

// Milestone 8C — Applicants over real local Postgres, mirroring
// careers.spec.ts (8B).
describe('Careers / Applicants (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let audit: InternalAuditService;
  let redis: RedisService;
  const originalEnv = { ...process.env };
  const internalSecret = 'applicants-spec-internal-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const jobIds: string[] = [];
  const applicationIds: string[] = [];
  const locationIds: string[] = [];

  const users: Record<string, string> = {};
  const roles: Record<string, string> = {};
  let activeLocationId: string;
  let inactiveLocationId: string;

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
        key: `applicants-spec-${suffix}-${randomUUID()}`,
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

  const adminReq = (
    method: 'get' | 'post',
    path: string,
    key: string,
  ) =>
    request(app.getHttpServer())
      [method](`/api/v1/admin/careers/applications${path}`)
      .set('Authorization', `Bearer ${token(key)}`);

  const submit = (jobId: string, body: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post(`/api/v1/careers/jobs/${jobId}/applications`)
      .send(body);

  function applicationBody(overrides: Record<string, unknown> = {}) {
    return {
      firstName: 'Dana',
      lastName: 'Rivera',
      email: `dana-${randomUUID()}@example.com`,
      phone: '555-0100',
      location: 'Austin, TX',
      workAuthorized: true,
      availability: 'Weekday mornings',
      message: 'I love coffee and hospitality.',
      ...overrides,
    };
  }

  // A publicly-visible corporate job to apply to, created directly.
  async function makeJob(
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; title: string }> {
    const job = await prisma.jobOpening.create({
      data: {
        title: `Barista ${suffix} ${randomUUID().slice(0, 8)}`,
        employmentType: 'FULL_TIME',
        summary: 'Make great coffee.',
        description: 'Full description.',
        responsibilities: 'Pull shots.',
        qualifications: 'Friendly.',
        status: 'PUBLISHED',
        publishedAt: new Date(),
        ...overrides,
      },
    });
    jobIds.push(job.id);
    return { id: job.id, title: job.title };
  }

  async function seedApplication(
    jobId: string,
    jobTitle: string,
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const row = await prisma.jobApplication.create({
      data: {
        jobOpeningId: jobId,
        jobTitleSnapshot: jobTitle,
        firstName: 'Seed',
        lastName: 'Applicant',
        email: `seed-${randomUUID()}@example.com`,
        phone: '555-0000',
        location: 'Dallas, TX',
        workAuthorized: true,
        availability: 'Anytime',
        message: 'Seed message.',
        ...overrides,
      },
    });
    applicationIds.push(row.id);
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
        CareersModule,
      ],
    })
      // Every supertest request shares one loopback IP, so the real ~5/min
      // Redis throttle would trip mid-suite. The guard's behaviour is
      // exercised directly against CareersPublicThrottleGuard below; here it
      // is a pass-through.
      .overrideGuard(CareersPublicThrottleGuard)
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
          name: `Applicants Active ${suffix}`,
          slug: `applicants-active-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;
    inactiveLocationId = (
      await prisma.location.create({
        data: {
          name: `Applicants Inactive ${suffix}`,
          slug: `applicants-inactive-${suffix}`,
          isActive: false,
          isDigitalOrderingEnabled: false,
        },
      })
    ).id;
    locationIds.push(activeLocationId, inactiveLocationId);

    roles.viewer = await makeRole('Applicants Viewer', ['applicants.view']);
    roles.manager = await makeRole('Applicants Manager', [
      'applicants.view',
      'applicants.manage',
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
    await prisma.jobApplicationNote.deleteMany({
      where: { jobApplicationId: { in: applicationIds } },
    });
    await prisma.jobApplication.deleteMany({
      where: {
        OR: [
          { id: { in: applicationIds } },
          { jobOpeningId: { in: jobIds } },
        ],
      },
    });
    await prisma.jobOpening.deleteMany({
      where: {
        OR: [{ id: { in: jobIds } }, { title: { contains: suffix } }],
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
    await prisma.location.deleteMany({ where: { id: { in: locationIds } } });
    await app.close();
    await prisma.$disconnect();
    process.env = { ...originalEnv };
  });

  // --- public submission -------------------------------------

  it('accepts an application for a visible job, stores it NEW with a title snapshot, returns only { ok: true }', async () => {
    const job = await makeJob();
    const body = applicationBody();
    const res = await submit(job.id, body).expect(201);
    expect(res.body).toEqual({ ok: true });

    const rows = await prisma.jobApplication.findMany({
      where: { jobOpeningId: job.id },
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    applicationIds.push(row.id);
    expect(row.status).toBe('NEW');
    expect(row.jobTitleSnapshot).toBe(job.title);
    expect(row.email).toBe(body.email);
    expect(row.workAuthorized).toBe(true);
    expect(row.resumeUrl).toBeNull();
  });

  it('keeps the job title snapshot even after the job is edited or archived', async () => {
    const job = await makeJob();
    await submit(job.id, applicationBody()).expect(201);
    await prisma.jobOpening.update({
      where: { id: job.id },
      data: { title: `Renamed ${suffix}`, status: 'ARCHIVED' },
    });
    const row = await prisma.jobApplication.findFirst({
      where: { jobOpeningId: job.id },
    });
    applicationIds.push(row!.id);
    expect(row!.jobTitleSnapshot).toBe(job.title);
  });

  it('allows multiple applications from the same email (no dedup)', async () => {
    const job = await makeJob();
    const email = `repeat-${randomUUID()}@example.com`;
    await submit(job.id, applicationBody({ email })).expect(201);
    await submit(job.id, applicationBody({ email })).expect(201);
    const count = await prisma.jobApplication.count({
      where: { jobOpeningId: job.id, email },
    });
    expect(count).toBe(2);
  });

  it('accepts an optional http(s) resume/link and rejects a non-http scheme', async () => {
    const job = await makeJob();
    await submit(
      job.id,
      applicationBody({ resumeUrl: 'https://linkedin.com/in/dana' }),
    ).expect(201);
    const row = await prisma.jobApplication.findFirst({
      where: { jobOpeningId: job.id },
    });
    applicationIds.push(row!.id);
    expect(row!.resumeUrl).toBe('https://linkedin.com/in/dana');

    await submit(
      job.id,
      applicationBody({ resumeUrl: 'javascript:alert(1)' }),
    ).expect(400);
    await submit(
      job.id,
      applicationBody({ resumeUrl: 'not a url' }),
    ).expect(400);
  });

  it('rejects missing / blank required fields and a bad email or non-boolean work authorization', async () => {
    const job = await makeJob();
    await submit(job.id, applicationBody({ firstName: '   ' })).expect(400);
    await submit(job.id, applicationBody({ email: 'nope' })).expect(400);
    await submit(job.id, applicationBody({ workAuthorized: 'yes' })).expect(400);
    await submit(job.id, applicationBody({ message: undefined })).expect(400);
  });

  it('returns 404 for a draft, archived, inactive-location, or unknown job — never revealing existence', async () => {
    const draft = await makeJob({ status: 'DRAFT', publishedAt: null });
    await submit(draft.id, applicationBody()).expect(404);

    const archived = await makeJob({ status: 'ARCHIVED' });
    await submit(archived.id, applicationBody()).expect(404);

    const atInactive = await makeJob({ locationId: inactiveLocationId });
    await submit(atInactive.id, applicationBody()).expect(404);

    await submit(randomUUID(), applicationBody()).expect(404);

    // none of the failed attempts wrote a row
    for (const jobId of [draft.id, archived.id, atInactive.id]) {
      expect(
        await prisma.jobApplication.count({ where: { jobOpeningId: jobId } }),
      ).toBe(0);
    }
  });

  it('does not audit a public submission', async () => {
    const job = await makeJob();
    const before = await prisma.internalAuditEvent.count();
    await submit(job.id, applicationBody()).expect(201);
    const row = await prisma.jobApplication.findFirst({
      where: { jobOpeningId: job.id },
    });
    applicationIds.push(row!.id);
    expect(await prisma.internalAuditEvent.count()).toBe(before);
  });

  // --- public throttle (guard, direct) ----------------------

  it('throttles roughly 5 submissions / minute / IP and fails OPEN when Redis is down', async () => {
    const guard = new CareersPublicThrottleGuard(redis);
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
      guard.canActivate(throttleContext('198.51.100.7')),
    ).resolves.toBe(true);
    spy.mockRestore();
  });

  // --- admin authorization ----------------------------------

  it('401 without a session; 403 without applicants.view; view cannot manage; LOCATION grant rejected', async () => {
    const job = await makeJob();
    const applicationId = await seedApplication(job.id, job.title);

    await request(app.getHttpServer())
      .get('/api/v1/admin/careers/applications')
      .expect(401);

    await adminReq('get', '', `noPerm-${suffix}`).expect(403);
    await adminReq('get', `/${applicationId}`, `noPerm-${suffix}`).expect(403);

    // applicants.view alone cannot change status or add a note
    await adminReq('post', `/${applicationId}/status`, `viewer-${suffix}`)
      .send({ status: 'REVIEWING' })
      .expect(403);
    await adminReq('post', `/${applicationId}/notes`, `viewer-${suffix}`)
      .send({ body: 'nope' })
      .expect(403);

    // CORPORATE-only — a LOCATION-scoped manager is rejected
    await adminReq('get', '', `locMgr-${suffix}`).expect(403);
    await adminReq('post', `/${applicationId}/status`, `locMgr-${suffix}`)
      .send({ status: 'REVIEWING' })
      .expect(403);
  });

  // --- admin list ------------------------------------------

  it('lists newest-first with status and job filters and cursor pagination', async () => {
    const jobA = await makeJob();
    const jobB = await makeJob();
    const created: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      created.push(await seedApplication(jobA.id, jobA.title));
    }
    const bId = await seedApplication(jobB.id, jobB.title, {
      status: 'REJECTED',
    });

    const all = (
      await adminReq('get', `?jobOpeningId=${jobA.id}`, `viewer-${suffix}`).expect(
        200,
      )
    ).body as AdminJobApplicationsResponse;
    expect(all.applications.map((a) => a.id)).toEqual([...created].reverse());
    expect(all.applications.every((a) => a.jobOpeningId === jobA.id)).toBe(true);

    const page1 = (
      await adminReq(
        'get',
        `?jobOpeningId=${jobA.id}&cursor=${created[2]!}`,
        `viewer-${suffix}`,
      ).expect(200)
    ).body as AdminJobApplicationsResponse;
    // cursor is the newest id -> only the two older remain
    expect(page1.applications.map((a) => a.id)).toEqual([
      created[1]!,
      created[0]!,
    ]);

    const rejected = (
      await adminReq('get', '?status=REJECTED', `viewer-${suffix}`).expect(200)
    ).body as AdminJobApplicationsResponse;
    expect(rejected.applications.map((a) => a.id)).toContain(bId);
    expect(rejected.applications.every((a) => a.status === 'REJECTED')).toBe(
      true,
    );

    await adminReq('get', '?status=BOGUS', `viewer-${suffix}`).expect(400);
  });

  // --- admin detail ---------------------------------------

  it('returns the full application detail; 404 for an unknown id', async () => {
    const job = await makeJob();
    const applicationId = await seedApplication(job.id, job.title, {
      firstName: 'Priya',
      lastName: 'Anand',
      resumeUrl: 'https://example.com/cv',
    });

    const detail = (
      await adminReq('get', `/${applicationId}`, `viewer-${suffix}`).expect(200)
    ).body as AdminJobApplicationDetail;
    expect(detail).toMatchObject({
      id: applicationId,
      status: 'NEW',
      jobOpeningId: job.id,
      jobTitleSnapshot: job.title,
      jobStatus: 'PUBLISHED',
      firstName: 'Priya',
      lastName: 'Anand',
      resumeUrl: 'https://example.com/cv',
    });
    expect(detail.notes).toEqual([]);
    expect(detail.activity).toEqual([]);

    await adminReq('get', `/${randomUUID()}`, `viewer-${suffix}`).expect(404);
  });

  // --- status changes -------------------------------------

  it('moves status freely between any valid values, rejects an invalid one, and audits atomically without PII', async () => {
    const job = await makeJob();
    const applicationId = await seedApplication(job.id, job.title);

    await adminReq('post', `/${applicationId}/status`, `manager-${suffix}`)
      .send({ status: 'HIRED' })
      .expect(201);
    await adminReq('post', `/${applicationId}/status`, `manager-${suffix}`)
      .send({ status: 'NEW' })
      .expect(201); // free backward movement, no transition graph
    await adminReq('post', `/${applicationId}/status`, `manager-${suffix}`)
      .send({ status: 'BOGUS' })
      .expect(400);

    const row = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
    });
    expect(row!.status).toBe('NEW');

    const events = await prisma.internalAuditEvent.findMany({
      where: {
        targetType: 'job_application',
        targetId: applicationId,
        action: 'applicants.application_status_changed',
      },
      orderBy: { createdAt: 'asc' },
    });
    expect(events).toHaveLength(2);
    expect(events[0]!.actorInternalUserId).toBe(users[`manager-${suffix}`]);
    expect(events[0]!.beforeData).toEqual({ status: 'NEW' });
    expect(events[0]!.afterData).toEqual({ status: 'HIRED' });
    // no candidate PII anywhere in the audit payloads
    const blob = JSON.stringify(events);
    expect(blob).not.toContain(row!.email);
    expect(blob).not.toContain(row!.firstName);

    // atomicity — audit write fails, status is not persisted
    const spy = jest
      .spyOn(audit, 'recordJobApplicationStatusChanged')
      .mockRejectedValueOnce(new Error('audit boom'));
    await adminReq('post', `/${applicationId}/status`, `manager-${suffix}`)
      .send({ status: 'REJECTED' })
      .expect(500);
    spy.mockRestore();
    const after = await prisma.jobApplication.findUnique({
      where: { id: applicationId },
    });
    expect(after!.status).toBe('NEW');
  });

  it('a no-op status change (same value) succeeds and writes no audit event', async () => {
    const job = await makeJob();
    const applicationId = await seedApplication(job.id, job.title);
    const before = await prisma.internalAuditEvent.count({
      where: { targetType: 'job_application', targetId: applicationId },
    });
    await adminReq('post', `/${applicationId}/status`, `manager-${suffix}`)
      .send({ status: 'NEW' })
      .expect(201);
    expect(
      await prisma.internalAuditEvent.count({
        where: { targetType: 'job_application', targetId: applicationId },
      }),
    ).toBe(before);
  });

  // --- notes ---------------------------------------------

  it('adds append-only notes (newest first) with the author, audits atomically, never storing the body in the audit', async () => {
    const job = await makeJob();
    const applicationId = await seedApplication(job.id, job.title);

    await adminReq('post', `/${applicationId}/notes`, `manager-${suffix}`)
      .send({ body: '  first note  ' })
      .expect(201);
    const list = (
      await adminReq('post', `/${applicationId}/notes`, `manager-${suffix}`)
        .send({ body: 'second note' })
        .expect(201)
    ).body as AdminJobApplicationDetail['notes'];
    expect(list.map((n) => n.body)).toEqual(['second note', 'first note']);
    expect(list.every((n) => n.authorLabel === `manager-${suffix}`)).toBe(true);

    // validation
    await adminReq('post', `/${applicationId}/notes`, `manager-${suffix}`)
      .send({ body: '   ' })
      .expect(400);
    await adminReq('post', `/${applicationId}/notes`, `manager-${suffix}`)
      .send({ body: 'x'.repeat(2001) })
      .expect(400);

    const events = await prisma.internalAuditEvent.findMany({
      where: {
        targetType: 'job_application',
        targetId: applicationId,
        action: 'applicants.note_added',
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
      .spyOn(audit, 'recordJobApplicationNoteAdded')
      .mockRejectedValueOnce(new Error('audit boom'));
    await adminReq('post', `/${applicationId}/notes`, `manager-${suffix}`)
      .send({ body: 'should not persist' })
      .expect(500);
    spy.mockRestore();
    expect(
      await prisma.jobApplicationNote.count({
        where: { jobApplicationId: applicationId, body: 'should not persist' },
      }),
    ).toBe(0);
  });

  it('GET notes and detail activity reflect status changes and notes', async () => {
    const job = await makeJob();
    const applicationId = await seedApplication(job.id, job.title);
    await adminReq('post', `/${applicationId}/status`, `manager-${suffix}`)
      .send({ status: 'REVIEWING' })
      .expect(201);
    await adminReq('post', `/${applicationId}/notes`, `manager-${suffix}`)
      .send({ body: 'called candidate' })
      .expect(201);

    const detail = (
      await adminReq('get', `/${applicationId}`, `viewer-${suffix}`).expect(200)
    ).body as AdminJobApplicationDetail;
    expect(detail.notes.map((n) => n.body)).toEqual(['called candidate']);
    const summaries = detail.activity.map((a) => a.summary);
    expect(summaries).toContain('Status changed from NEW to REVIEWING');
    expect(summaries).toContain('Internal note added');

    const notes = (
      await adminReq('get', `/${applicationId}/notes`, `viewer-${suffix}`).expect(
        200,
      )
    ).body as AdminJobApplicationDetail['notes'];
    expect(notes.map((n) => n.body)).toEqual(['called candidate']);
  });

  // --- privacy -----------------------------------------

  it('exposes no public GET for an application', async () => {
    const job = await makeJob();
    const applicationId = await seedApplication(job.id, job.title);
    await request(app.getHttpServer())
      .get(`/api/v1/careers/jobs/${job.id}/applications`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/careers/applications/${applicationId}`)
      .expect(404);
  });

  it('an application survives its job being archived and stays visible to HQ', async () => {
    const job = await makeJob();
    const applicationId = await seedApplication(job.id, job.title);
    await prisma.jobOpening.update({
      where: { id: job.id },
      data: { status: 'ARCHIVED' },
    });
    const detail = (
      await adminReq('get', `/${applicationId}`, `viewer-${suffix}`).expect(200)
    ).body as AdminJobApplicationDetail;
    expect(detail.jobStatus).toBe('ARCHIVED');
    expect(detail.jobTitleSnapshot).toBe(job.title);
  });
});
