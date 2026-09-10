import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import type {
  AdminJobOpening,
  AdminJobOpeningsResponse,
  PublicJobOpeningDetail,
  PublicJobOpeningsResponse,
} from '@mocha-house/contracts';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { signInternalDevJwt } from '../internal-auth/infrastructure/internal-dev-jwt';
import { InternalAuditService } from '../audit/internal-audit.service';
import { CareersModule } from './careers.module';

// Milestone 8B — Careers / Job Openings over real local Postgres, mirroring
// admin-audit.spec.ts.
describe('Careers / Job Openings (integration)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let audit: InternalAuditService;
  const originalEnv = { ...process.env };
  const internalSecret = 'careers-spec-internal-secret';
  const suffix = randomUUID();

  const userIds: string[] = [];
  const roleIds: string[] = [];
  const jobIds: string[] = [];
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
        key: `careers-spec-${suffix}-${randomUUID()}`,
        displayName: name,
        permissions: { create: keys.map((permissionKey) => ({ permissionKey })) },
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
    method: 'get' | 'post' | 'patch',
    path: string,
    key: string,
  ) =>
    request(app.getHttpServer())
      [method](`/api/v1/admin/careers/jobs${path}`)
      .set('Authorization', `Bearer ${token(key)}`);

  const publicList = () =>
    request(app.getHttpServer()).get('/api/v1/careers/jobs');
  const publicDetail = (id: string) =>
    request(app.getHttpServer()).get(`/api/v1/careers/jobs/${id}`);

  function jobBody(overrides: Record<string, unknown> = {}) {
    return {
      title: `Barista ${suffix}`,
      employmentType: 'FULL_TIME',
      summary: 'Make great coffee.',
      description: 'Full description of the barista role.',
      responsibilities: 'Pull shots. Greet guests.',
      qualifications: 'Friendly. Reliable.',
      ...overrides,
    };
  }

  async function createJob(
    key: string,
    overrides: Record<string, unknown> = {},
  ): Promise<AdminJobOpening> {
    const res = await adminReq('post', '', key)
      .send(jobBody(overrides))
      .expect(201);
    const job = res.body as AdminJobOpening;
    jobIds.push(job.id);
    return job;
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
    }).compile();
    app = moduleFixture.createNestApplication();
    await app.init();
    prisma = moduleFixture.get(PrismaService);
    audit = moduleFixture.get(InternalAuditService);

    activeLocationId = (
      await prisma.location.create({
        data: {
          name: `Careers Active ${suffix}`,
          slug: `careers-active-${suffix}`,
          isActive: true,
          isDigitalOrderingEnabled: true,
        },
      })
    ).id;
    inactiveLocationId = (
      await prisma.location.create({
        data: {
          name: `Careers Inactive ${suffix}`,
          slug: `careers-inactive-${suffix}`,
          isActive: false,
          isDigitalOrderingEnabled: false,
        },
      })
    ).id;
    locationIds.push(activeLocationId, inactiveLocationId);

    roles.viewer = await makeRole('Careers Viewer', ['careers.view']);
    roles.manager = await makeRole('Careers Manager', [
      'careers.view',
      'careers.manage',
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

  // --- authorization ----------------------------------------

  it('401 without a session; 403 without the permission', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/admin/careers/jobs')
      .expect(401);
    await adminReq('get', '', `noPerm-${suffix}`).expect(403);
    await adminReq('post', '', `noPerm-${suffix}`).send(jobBody()).expect(403);
  });

  it('careers.view cannot mutate (403)', async () => {
    await adminReq('post', '', `viewer-${suffix}`).send(jobBody()).expect(403);
    const job = await createJob(`manager-${suffix}`);
    await adminReq('post', `/${job.id}/publish`, `viewer-${suffix}`).expect(403);
    await adminReq('patch', `/${job.id}`, `viewer-${suffix}`)
      .send({ title: 'x' })
      .expect(403);
  });

  it('careers.manage held only at LOCATION scope is rejected (CORPORATE-only)', async () => {
    await adminReq('get', '', `locMgr-${suffix}`).expect(403);
    await adminReq('post', '', `locMgr-${suffix}`).send(jobBody()).expect(403);
  });

  // --- CRUD -------------------------------------------------

  it('creates a DRAFT — corporate and location jobs; validation; unknown location', async () => {
    const corporate = await createJob(`manager-${suffix}`);
    expect(corporate.status).toBe('DRAFT');
    expect(corporate.publishedAt).toBeNull();
    expect(corporate.location).toBeNull();

    const located = await createJob(`manager-${suffix}`, {
      locationId: activeLocationId,
    });
    expect(located.location).toEqual({
      id: activeLocationId,
      name: `Careers Active ${suffix}`,
    });

    await adminReq('post', '', `manager-${suffix}`)
      .send(jobBody({ title: '  ' }))
      .expect(400);
    await adminReq('post', '', `manager-${suffix}`)
      .send(jobBody({ employmentType: 'INTERN' }))
      .expect(400);
    await adminReq('post', '', `manager-${suffix}`)
      .send(jobBody({ locationId: randomUUID() }))
      .expect(400);
  });

  it('edits fields; PATCH cannot change status', async () => {
    const job = await createJob(`manager-${suffix}`);
    const updated = (
      await adminReq('patch', `/${job.id}`, `manager-${suffix}`)
        .send({ title: 'Lead Barista', employmentType: 'PART_TIME' })
        .expect(200)
    ).body as AdminJobOpening;
    expect(updated.title).toBe('Lead Barista');
    expect(updated.employmentType).toBe('PART_TIME');
    expect(updated.status).toBe('DRAFT');

    await adminReq('patch', `/${job.id}`, `manager-${suffix}`)
      .send({ status: 'PUBLISHED' })
      .expect(400);
    await adminReq('patch', `/${job.id}`, `manager-${suffix}`)
      .send({ publishedAt: new Date().toISOString() })
      .expect(400);

    // clearing the location -> corporate
    const cleared = (
      await adminReq('patch', `/${job.id}`, `manager-${suffix}`)
        .send({ locationId: null })
        .expect(200)
    ).body as AdminJobOpening;
    expect(cleared.location).toBeNull();
  });

  it('status filter on the admin list', async () => {
    const draft = await createJob(`manager-${suffix}`);
    await adminReq('post', `/${draft.id}/publish`, `manager-${suffix}`).expect(
      201,
    );
    const published = (
      await adminReq('get', '?status=PUBLISHED', `viewer-${suffix}`).expect(200)
    ).body as AdminJobOpeningsResponse;
    expect(published.jobs.every((j) => j.status === 'PUBLISHED')).toBe(true);
    expect(published.jobs.map((j) => j.id)).toContain(draft.id);
    await adminReq('get', '?status=BOGUS', `viewer-${suffix}`).expect(400);
  });

  // --- lifecycle ------------------------------------------

  it('publish / unpublish / archive, publishedAt set once and retained, invalid transitions -> 409', async () => {
    const job = await createJob(`manager-${suffix}`);

    // unpublish a draft -> 409
    await adminReq('post', `/${job.id}/unpublish`, `manager-${suffix}`).expect(
      409,
    );

    const published = (
      await adminReq('post', `/${job.id}/publish`, `manager-${suffix}`).expect(
        201,
      )
    ).body as AdminJobOpening;
    expect(published.status).toBe('PUBLISHED');
    expect(published.publishedAt).not.toBeNull();
    const firstPublishedAt = published.publishedAt;

    // publish again -> 409 (already published)
    await adminReq('post', `/${job.id}/publish`, `manager-${suffix}`).expect(
      409,
    );

    const unpublished = (
      await adminReq('post', `/${job.id}/unpublish`, `manager-${suffix}`).expect(
        201,
      )
    ).body as AdminJobOpening;
    expect(unpublished.status).toBe('DRAFT');
    expect(unpublished.publishedAt).toBe(firstPublishedAt); // retained

    const republished = (
      await adminReq('post', `/${job.id}/publish`, `manager-${suffix}`).expect(
        201,
      )
    ).body as AdminJobOpening;
    expect(republished.publishedAt).toBe(firstPublishedAt); // still the first

    const archived = (
      await adminReq('post', `/${job.id}/archive`, `manager-${suffix}`).expect(
        201,
      )
    ).body as AdminJobOpening;
    expect(archived.status).toBe('ARCHIVED');

    // ARCHIVED is terminal
    await adminReq('post', `/${job.id}/publish`, `manager-${suffix}`).expect(
      409,
    );
    await adminReq('post', `/${job.id}/unpublish`, `manager-${suffix}`).expect(
      409,
    );
    await adminReq('patch', `/${job.id}`, `manager-${suffix}`)
      .send({ title: 'nope' })
      .expect(409);
  });

  it('archive directly from DRAFT', async () => {
    const job = await createJob(`manager-${suffix}`);
    const archived = (
      await adminReq('post', `/${job.id}/archive`, `manager-${suffix}`).expect(
        201,
      )
    ).body as AdminJobOpening;
    expect(archived.status).toBe('ARCHIVED');
  });

  it('404 for an unknown job id (admin detail + actions)', async () => {
    const missing = randomUUID();
    await adminReq('get', `/${missing}`, `viewer-${suffix}`).expect(404);
    await adminReq('post', `/${missing}/publish`, `manager-${suffix}`).expect(
      404,
    );
  });

  // --- audit ---------------------------------------------

  it('audits create / update / publish / unpublish / archive with the authenticated actor, atomically', async () => {
    const before = await prisma.internalAuditEvent.count();
    const job = await createJob(`manager-${suffix}`);
    await adminReq('patch', `/${job.id}`, `manager-${suffix}`)
      .send({ summary: 'Updated summary.' })
      .expect(200);
    await adminReq('post', `/${job.id}/publish`, `manager-${suffix}`).expect(
      201,
    );
    await adminReq('post', `/${job.id}/unpublish`, `manager-${suffix}`).expect(
      201,
    );
    await adminReq('post', `/${job.id}/archive`, `manager-${suffix}`).expect(
      201,
    );

    const events = await prisma.internalAuditEvent.findMany({
      where: { targetType: 'job_opening', targetId: job.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((e) => e.action)).toEqual([
      'careers.job_created',
      'careers.job_updated',
      'careers.job_published',
      'careers.job_unpublished',
      'careers.job_archived',
    ]);
    expect(
      events.every((e) => e.actorInternalUserId === users[`manager-${suffix}`]),
    ).toBe(true);
    expect(await prisma.internalAuditEvent.count()).toBe(before + 5);

    // atomicity: a create whose audit write fails leaves no job row.
    const spy = jest
      .spyOn(audit, 'recordJobOpeningCreated')
      .mockRejectedValueOnce(new Error('audit boom'));
    await adminReq('post', '', `manager-${suffix}`)
      .send(jobBody({ title: `Atomic ${suffix}` }))
      .expect(500);
    spy.mockRestore();
    const orphan = await prisma.jobOpening.findFirst({
      where: { title: `Atomic ${suffix}` },
    });
    expect(orphan).toBeNull();
  });

  // --- public -------------------------------------------

  it('public list: only PUBLISHED + visible; corporate published shown; inactive-location hidden', async () => {
    const draft = await createJob(`manager-${suffix}`, {
      title: `Public Draft ${suffix}`,
    });
    const corporate = await createJob(`manager-${suffix}`, {
      title: `Public Corporate ${suffix}`,
    });
    await adminReq(
      'post',
      `/${corporate.id}/publish`,
      `manager-${suffix}`,
    ).expect(201);
    const atInactive = await createJob(`manager-${suffix}`, {
      title: `Public Inactive Loc ${suffix}`,
      locationId: inactiveLocationId,
    });
    await adminReq(
      'post',
      `/${atInactive.id}/publish`,
      `manager-${suffix}`,
    ).expect(201);
    const atActive = await createJob(`manager-${suffix}`, {
      title: `Public Active Loc ${suffix}`,
      locationId: activeLocationId,
    });
    await adminReq(
      'post',
      `/${atActive.id}/publish`,
      `manager-${suffix}`,
    ).expect(201);

    const list = (await publicList().expect(200))
      .body as PublicJobOpeningsResponse;
    const ids = list.jobs.map((j) => j.id);
    expect(ids).toContain(corporate.id);
    expect(ids).toContain(atActive.id);
    expect(ids).not.toContain(draft.id);
    expect(ids).not.toContain(atInactive.id);

    const corporateRow = list.jobs.find((j) => j.id === corporate.id)!;
    expect(corporateRow.locationName).toBeNull();
    expect(
      list.jobs.find((j) => j.id === atActive.id)!.locationName,
    ).toBe(`Careers Active ${suffix}`);
    // no long-form fields in the summary
    expect(JSON.stringify(corporateRow)).not.toContain('description');
  });

  it('public detail: 200 for a visible job; 404 for draft / archived / inactive-location / unknown', async () => {
    const job = await createJob(`manager-${suffix}`, {
      title: `Detail ${suffix}`,
      description: 'Detailed body here.',
    });
    await publicDetail(job.id).expect(404); // still a draft

    await adminReq('post', `/${job.id}/publish`, `manager-${suffix}`).expect(
      201,
    );
    const detail = (await publicDetail(job.id).expect(200))
      .body as PublicJobOpeningDetail;
    expect(detail.description).toBe('Detailed body here.');
    expect(detail.responsibilities).toBeDefined();

    await adminReq('post', `/${job.id}/archive`, `manager-${suffix}`).expect(
      201,
    );
    await publicDetail(job.id).expect(404); // archived

    const atInactive = await createJob(`manager-${suffix}`, {
      title: `Detail Inactive ${suffix}`,
      locationId: inactiveLocationId,
    });
    await adminReq(
      'post',
      `/${atInactive.id}/publish`,
      `manager-${suffix}`,
    ).expect(201);
    await publicDetail(atInactive.id).expect(404); // inactive location

    await publicDetail(randomUUID()).expect(404); // unknown
  });
});
