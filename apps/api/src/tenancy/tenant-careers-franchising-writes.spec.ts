import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { TENANT_1_MOCHA_HOUSE_ID } from '@mocha-house/database';
import {
  TEST_TENANT_B_ID,
  createTestTenantB,
  removeTestTenantB,
  tenantContextFor,
} from '@mocha-house/testing';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { InternalAuthModule } from '../internal-auth/internal-auth.module';
import { RedisModule } from '../redis/redis.module';
import { CareersModule } from '../careers/careers.module';
import { FranchisingModule } from '../franchising/franchising.module';
import { JobOpeningsAdminService } from '../careers/application/job-openings-admin.service';
import { JobApplicationsPublicService } from '../careers/application/job-applications-public.service';
import { JobApplicationsAdminService } from '../careers/application/job-applications-admin.service';
import { JobApplicationNotesService } from '../careers/application/job-application-notes.service';
import { FranchiseInquiriesPublicService } from '../franchising/application/franchise-inquiries-public.service';
import { FranchiseInquiriesAdminService } from '../franchising/application/franchise-inquiries-admin.service';
import { FranchiseInquiryNotesService } from '../franchising/application/franchise-inquiry-notes.service';
import { AuthorizationContext } from '../internal-auth/authorization/authorization-context';

// Milestone S0D-2D — careers & franchising tenant ownership. Mirrors
// tenant-order-payment-writes.spec.ts (S0D-2C-1): JobOpening / FranchiseInquiry
// take their tenant ONLY from the request's server-side TenantContext (never
// client input), JobApplication / JobApplicationNote / FranchiseInquiryNote
// copy ownership from their validated parent, and every admin mutation
// (update, publish, unpublish, archive, status change, note) re-checks that
// the target still belongs to the caller's tenant BEFORE any state/status
// check that could otherwise disclose a foreign record's existence.
describe('S0D-2D careers & franchising tenant ownership (integration)', () => {
  let app: INestApplication<App>;
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let jobOpenings: JobOpeningsAdminService;
  let applications: JobApplicationsPublicService;
  let applicationsAdmin: JobApplicationsAdminService;
  let applicationNotes: JobApplicationNotesService;
  let inquiries: FranchiseInquiriesPublicService;
  let inquiriesAdmin: FranchiseInquiriesAdminService;
  let inquiryNotes: FranchiseInquiryNotesService;
  const originalEnv = { ...process.env };
  const suffix = randomUUID().slice(0, 8);

  const tenantOne = tenantContextFor(TENANT_1_MOCHA_HOUSE_ID);
  const tenantB = tenantContextFor(TEST_TENANT_B_ID);
  const corporate = [{ scopeType: 'CORPORATE' as const, scopeId: null }];
  const careersManage = AuthorizationContext.of({
    'careers.view': corporate,
    'careers.manage': corporate,
  });
  const applicantsManage = AuthorizationContext.of({
    'applicants.view': corporate,
    'applicants.manage': corporate,
  });
  const franchisingManage = AuthorizationContext.of({
    'franchising.view': corporate,
    'franchising.manage': corporate,
  });

  let actorId: string;
  const locationIds: string[] = [];
  const jobIds: string[] = [];
  const applicationIds: string[] = [];
  const inquiryIds: string[] = [];

  interface LocationFixture {
    tenantId: string;
    locationId: string;
  }
  let t1: LocationFixture;
  let tb: LocationFixture;

  async function makeLocation(
    tenantId: string,
    label: string,
  ): Promise<LocationFixture> {
    const location = await prisma.location.create({
      data: {
        tenantId,
        name: `S0D2D ${label} ${suffix}`,
        slug: `s0d2d-${label}-${suffix}`,
      },
    });
    locationIds.push(location.id);
    return { tenantId, locationId: location.id };
  }

  const jobBody = (overrides: Record<string, unknown> = {}) => ({
    title: `S0D2D Barista ${suffix} ${randomUUID().slice(0, 8)}`,
    employmentType: 'FULL_TIME' as const,
    summary: 'Make great coffee.',
    description: 'Full description.',
    responsibilities: 'Pull shots.',
    qualifications: 'Friendly.',
    ...overrides,
  });

  const applicationBody = (overrides: Record<string, unknown> = {}) => ({
    firstName: 'Dana',
    lastName: 'Rivera',
    email: `dana-${randomUUID()}@example.com`,
    phone: '555-0100',
    location: 'Austin, TX',
    workAuthorized: true,
    availability: 'Weekday mornings',
    message: 'I love coffee and hospitality.',
    ...overrides,
  });

  const inquiryBody = (overrides: Record<string, unknown> = {}) => ({
    firstName: 'Jordan',
    lastName: 'Lee',
    email: `jordan-${randomUUID()}@example.com`,
    phone: '555-0100',
    city: 'Austin',
    state: 'TX',
    country: 'USA',
    preferredMarket: `Central Texas ${randomUUID().slice(0, 8)}`,
    consentAcknowledged: true,
    ...overrides,
  });

  async function createPublishedJob(
    tenant: typeof tenantOne,
    locationId?: string,
  ) {
    const job = await jobOpenings.create(
      jobBody({ locationId }),
      actorId,
      careersManage,
      tenant,
    );
    jobIds.push(job.id);
    await jobOpenings.publish(job.id, actorId, careersManage, tenant);
    return job;
  }

  async function createApplication(tenant: typeof tenantOne, jobId: string) {
    await applications.submit(jobId, applicationBody(), tenant);
    const row = await prisma.jobApplication.findFirstOrThrow({
      where: { jobOpeningId: jobId },
      orderBy: { createdAt: 'desc' },
    });
    applicationIds.push(row.id);
    return row;
  }

  async function createInquiry(tenant: typeof tenantOne) {
    const body = inquiryBody();
    await inquiries.submit(body, tenant);
    const row = await prisma.franchiseInquiry.findFirstOrThrow({
      where: { email: body.email },
    });
    inquiryIds.push(row.id);
    return row;
  }

  beforeAll(async () => {
    process.env.NODE_ENV = 'development';

    moduleRef = await Test.createTestingModule({
      imports: [
        PrismaModule,
        CustomerAuthModule,
        InternalAuthModule,
        RedisModule,
        CareersModule,
        FranchisingModule,
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = moduleRef.get(PrismaService);
    jobOpenings = moduleRef.get(JobOpeningsAdminService);
    applications = moduleRef.get(JobApplicationsPublicService);
    applicationsAdmin = moduleRef.get(JobApplicationsAdminService);
    applicationNotes = moduleRef.get(JobApplicationNotesService);
    inquiries = moduleRef.get(FranchiseInquiriesPublicService);
    inquiriesAdmin = moduleRef.get(FranchiseInquiriesAdminService);
    inquiryNotes = moduleRef.get(FranchiseInquiryNotesService);

    await createTestTenantB(prisma);
    t1 = await makeLocation(TENANT_1_MOCHA_HOUSE_ID, 't1');
    tb = await makeLocation(TEST_TENANT_B_ID, 'b');

    const user = await prisma.internalUser.create({
      data: {
        externalProvider: 'internal-dev',
        externalSubject: `internal-dev:s0d2d-${suffix}`,
        email: `s0d2d-${suffix}@example.com`,
        displayName: 'S0D2D Actor',
        status: 'ACTIVE',
        activatedAt: new Date(),
      },
    });
    actorId = user.id;
  });

  afterAll(async () => {
    // Deletes by tenantId (not just the tracked id arrays) so a prior run
    // interrupted mid-cleanup can never leave a row that blocks
    // removeTestTenantB's FK check on a later run. Wrapped so app.close()
    // always runs — an exception here must never leak an open connection.
    try {
      await prisma.outboxEvent.deleteMany({
        where: {
          tenantId: TEST_TENANT_B_ID,
          aggregateType: { in: ['JobApplication', 'FranchiseInquiry'] },
        },
      });
      await prisma.outboxEvent.deleteMany({
        where: {
          OR: [
            { aggregateType: 'JobApplication', aggregateId: { in: applicationIds } },
            { aggregateType: 'FranchiseInquiry', aggregateId: { in: inquiryIds } },
          ],
        },
      });
      await prisma.internalAuditEvent.deleteMany({
        where: { actorInternalUserId: actorId },
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
      await prisma.jobOpening.deleteMany({ where: { id: { in: jobIds } } });
      await prisma.franchiseInquiryNote.deleteMany({
        where: { franchiseInquiryId: { in: inquiryIds } },
      });
      await prisma.franchiseInquiry.deleteMany({
        where: { id: { in: inquiryIds } },
      });
      await prisma.internalUser.deleteMany({ where: { id: actorId } });
      await prisma.location.deleteMany({ where: { id: { in: locationIds } } });
      await removeTestTenantB(prisma);
    } finally {
      await app.close();
      process.env = { ...originalEnv };
    }
  });

  describe('root ownership — JobOpening', () => {
    it('persists Tenant #1 on a corporate job, whatever tenant the client claims', async () => {
      // CreateJobOpeningRequest has no tenantId field at all — this proves
      // a client-supplied one is simply ignored (TypeScript can't even
      // express smuggling it through the real contract type).
      const job = await jobOpenings.create(
        { ...jobBody(), tenantId: TEST_TENANT_B_ID } as never,
        actorId,
        careersManage,
        tenantOne,
      );
      jobIds.push(job.id);
      const row = await prisma.jobOpening.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(row.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
    });

    it('Tenant B structural equivalent: a Tenant B context persists Tenant B', async () => {
      const job = await jobOpenings.create(jobBody(), actorId, careersManage, tenantB);
      jobIds.push(job.id);
      const row = await prisma.jobOpening.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(row.tenantId).toBe(TEST_TENANT_B_ID);
    });

    it('a Tenant A job cannot reference a Tenant B Location on create', async () => {
      const attempted = jobBody({ locationId: tb.locationId });
      await expect(
        jobOpenings.create(attempted, actorId, careersManage, tenantOne),
      ).rejects.toThrow('That location does not exist.');
      expect(
        await prisma.jobOpening.count({
          where: { title: attempted.title },
        }),
      ).toBe(0);
    });

    it('an unknown location and a foreign-tenant location fail identically', async () => {
      const unknown = jobOpenings.create(
        jobBody({ locationId: randomUUID() }),
        actorId,
        careersManage,
        tenantOne,
      );
      const foreign = jobOpenings.create(
        jobBody({ locationId: tb.locationId }),
        actorId,
        careersManage,
        tenantOne,
      );
      await expect(unknown).rejects.toThrow('That location does not exist.');
      await expect(foreign).rejects.toThrow('That location does not exist.');
    });

    it('a Tenant A job cannot be updated to reference a Tenant B Location', async () => {
      const job = await jobOpenings.create(jobBody(), actorId, careersManage, tenantOne);
      jobIds.push(job.id);
      await expect(
        jobOpenings.update(
          job.id,
          { locationId: tb.locationId },
          actorId,
          careersManage,
          tenantOne,
        ),
      ).rejects.toThrow('That location does not exist.');
      const row = await prisma.jobOpening.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(row.locationId).toBeNull();
    });

    it('Tenant A cannot update / publish / unpublish / archive a Tenant B job — same 404 as missing, no audit event, owner can still act', async () => {
      const job = await jobOpenings.create(jobBody(), actorId, careersManage, tenantB);
      jobIds.push(job.id);
      const notFound = new NotFoundException('Job opening not found.');
      const auditBefore = await prisma.internalAuditEvent.count({
        where: { targetType: 'job_opening', targetId: job.id },
      });

      await expect(
        jobOpenings.update(
          job.id,
          { title: 'nope' },
          actorId,
          careersManage,
          tenantOne,
        ),
      ).rejects.toThrow(notFound);
      await expect(
        jobOpenings.publish(job.id, actorId, careersManage, tenantOne),
      ).rejects.toThrow(notFound);
      await expect(
        jobOpenings.unpublish(job.id, actorId, careersManage, tenantOne),
      ).rejects.toThrow(notFound);
      await expect(
        jobOpenings.archive(job.id, actorId, careersManage, tenantOne),
      ).rejects.toThrow(notFound);
      // A missing job gets the identical message.
      await expect(
        jobOpenings.update(
          randomUUID(),
          { title: 'nope' },
          actorId,
          careersManage,
          tenantOne,
        ),
      ).rejects.toThrow(notFound);

      expect(
        await prisma.internalAuditEvent.count({
          where: { targetType: 'job_opening', targetId: job.id },
        }),
      ).toBe(auditBefore);
      const unchanged = await prisma.jobOpening.findUniqueOrThrow({
        where: { id: job.id },
      });
      expect(unchanged.title).toBe(job.title);
      expect(unchanged.status).toBe('DRAFT');

      // The owning tenant can still act on it.
      const published = await jobOpenings.publish(
        job.id,
        actorId,
        careersManage,
        tenantB,
      );
      expect(published.status).toBe('PUBLISHED');
    });
  });

  describe('JobApplication — tenant copied from the validated JobOpening', () => {
    it('persists Tenant #1 / Tenant B from the job it applies to', async () => {
      const jobT1 = await createPublishedJob(tenantOne);
      const jobB = await createPublishedJob(tenantB);

      const appT1 = await createApplication(tenantOne, jobT1.id);
      const appB = await createApplication(tenantB, jobB.id);

      expect(appT1.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
      expect(appB.tenantId).toBe(TEST_TENANT_B_ID);

      const eventT1 = await prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateType: 'JobApplication', aggregateId: appT1.id },
      });
      const eventB = await prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateType: 'JobApplication', aggregateId: appB.id },
      });
      expect(eventT1.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
      expect(eventB.tenantId).toBe(TEST_TENANT_B_ID);
    });

    it("a foreign job's application attempt is rejected exactly like a missing job, creating nothing", async () => {
      const jobB = await createPublishedJob(tenantB);

      await expect(
        applications.submit(jobB.id, applicationBody(), tenantOne),
      ).rejects.toThrow(new NotFoundException('Job opening not found.'));

      expect(
        await prisma.jobApplication.count({ where: { jobOpeningId: jobB.id } }),
      ).toBe(0);
      expect(
        await prisma.outboxEvent.count({
          where: {
            aggregateType: 'JobApplication',
            payload: { path: ['jobOpeningId'], equals: jobB.id },
          },
        }),
      ).toBe(0);
    });

    it('Tenant A cannot change status on a Tenant B application — same 404, no audit event, owner can still act', async () => {
      const jobB = await createPublishedJob(tenantB);
      const appB = await createApplication(tenantB, jobB.id);
      const notFound = new NotFoundException('Application not found.');
      const auditBefore = await prisma.internalAuditEvent.count({
        where: { targetType: 'job_application', targetId: appB.id },
      });

      await expect(
        applicationsAdmin.updateStatus(
          appB.id,
          'HIRED',
          actorId,
          applicantsManage,
          tenantOne,
        ),
      ).rejects.toThrow(notFound);

      expect(
        await prisma.internalAuditEvent.count({
          where: { targetType: 'job_application', targetId: appB.id },
        }),
      ).toBe(auditBefore);
      const unchanged = await prisma.jobApplication.findUniqueOrThrow({
        where: { id: appB.id },
      });
      expect(unchanged.status).toBe('NEW');

      const updated = await applicationsAdmin.updateStatus(
        appB.id,
        'HIRED',
        actorId,
        applicantsManage,
        tenantB,
      );
      expect(updated.status).toBe('HIRED');
    });

    it('Tenant A cannot add a note to a Tenant B application — same 404, note copies the owning tenant', async () => {
      const jobB = await createPublishedJob(tenantB);
      const appB = await createApplication(tenantB, jobB.id);

      await expect(
        applicationNotes.addNote(
          appB.id,
          'cross-tenant note',
          actorId,
          applicantsManage,
          tenantOne,
        ),
      ).rejects.toThrow(new NotFoundException('Application not found.'));
      expect(
        await prisma.jobApplicationNote.count({
          where: { jobApplicationId: appB.id },
        }),
      ).toBe(0);

      await applicationNotes.addNote(
        appB.id,
        'owned note',
        actorId,
        applicantsManage,
        tenantB,
      );
      const note = await prisma.jobApplicationNote.findFirstOrThrow({
        where: { jobApplicationId: appB.id },
      });
      expect(note.tenantId).toBe(TEST_TENANT_B_ID);
    });
  });

  describe('root ownership — FranchiseInquiry', () => {
    it('persists Tenant #1 on an inquiry, whatever tenant the client claims', async () => {
      const body = { ...inquiryBody(), tenantId: TEST_TENANT_B_ID };
      await inquiries.submit(body as never, tenantOne);
      const row = await prisma.franchiseInquiry.findFirstOrThrow({
        where: { email: body.email },
      });
      inquiryIds.push(row.id);
      expect(row.tenantId).toBe(TENANT_1_MOCHA_HOUSE_ID);
    });

    it('Tenant B structural equivalent: a Tenant B context persists Tenant B', async () => {
      const inquiry = await createInquiry(tenantB);
      expect(inquiry.tenantId).toBe(TEST_TENANT_B_ID);

      const event = await prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateType: 'FranchiseInquiry', aggregateId: inquiry.id },
      });
      expect(event.tenantId).toBe(TEST_TENANT_B_ID);
    });

    it('Tenant A cannot change status on a Tenant B inquiry — same 404, no audit event, owner can still act', async () => {
      const inquiryB = await createInquiry(tenantB);
      const notFound = new NotFoundException('Franchise inquiry not found.');
      const auditBefore = await prisma.internalAuditEvent.count({
        where: { targetType: 'franchise_inquiry', targetId: inquiryB.id },
      });

      await expect(
        inquiriesAdmin.updateStatus(
          inquiryB.id,
          'CONTACTED',
          actorId,
          franchisingManage,
          tenantOne,
        ),
      ).rejects.toThrow(notFound);

      expect(
        await prisma.internalAuditEvent.count({
          where: { targetType: 'franchise_inquiry', targetId: inquiryB.id },
        }),
      ).toBe(auditBefore);
      const unchanged = await prisma.franchiseInquiry.findUniqueOrThrow({
        where: { id: inquiryB.id },
      });
      expect(unchanged.status).toBe('NEW');

      const updated = await inquiriesAdmin.updateStatus(
        inquiryB.id,
        'CONTACTED',
        actorId,
        franchisingManage,
        tenantB,
      );
      expect(updated.status).toBe('CONTACTED');
    });

    it('Tenant A cannot add a note to a Tenant B inquiry — same 404, note copies the owning tenant', async () => {
      const inquiryB = await createInquiry(tenantB);

      await expect(
        inquiryNotes.addNote(
          inquiryB.id,
          'cross-tenant note',
          actorId,
          franchisingManage,
          tenantOne,
        ),
      ).rejects.toThrow(new NotFoundException('Franchise inquiry not found.'));
      expect(
        await prisma.franchiseInquiryNote.count({
          where: { franchiseInquiryId: inquiryB.id },
        }),
      ).toBe(0);

      await inquiryNotes.addNote(
        inquiryB.id,
        'owned note',
        actorId,
        franchisingManage,
        tenantB,
      );
      const note = await prisma.franchiseInquiryNote.findFirstOrThrow({
        where: { franchiseInquiryId: inquiryB.id },
      });
      expect(note.tenantId).toBe(TEST_TENANT_B_ID);
    });
  });
});
