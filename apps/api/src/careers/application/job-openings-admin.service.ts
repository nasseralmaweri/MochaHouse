import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AdminJobOpening,
  AdminJobOpeningOptions,
  AdminJobOpeningsResponse,
  CreateJobOpeningRequest,
  JobEmploymentType,
  JobOpeningStatus,
  UpdateJobOpeningRequest,
} from '@mocha-house/contracts';
import {
  JOB_OPENING_LONG_TEXT_MAX_LENGTH,
  JOB_OPENING_SUMMARY_MAX_LENGTH,
  JOB_OPENING_TITLE_MAX_LENGTH,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import {
  toAdminJobOpening,
  type JobOpeningRow,
} from './job-opening-mapper';

const EMPLOYMENT_TYPES: readonly JobEmploymentType[] = [
  'FULL_TIME',
  'PART_TIME',
  'TEMPORARY',
  'SEASONAL',
];

const JOB_INCLUDE = {
  location: { select: { id: true, name: true, isActive: true } },
} satisfies Prisma.JobOpeningInclude;

// HQ management of Careers / Job Openings (Milestone 8B). `careers.view` and
// `careers.manage` are CORPORATE-only in the permission catalog —
// PermissionGuard rejects a LOCATION grant and every method here also calls
// `assertCorporate`. Status changes ONLY through the explicit
// publish / unpublish / archive actions; PATCH never touches status.
// ARCHIVED is terminal in 8B (no edit, no publish, no unarchive).
@Injectable()
export class JobOpeningsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
  ) {}

  async list(
    status: string | undefined,
    authorization: AuthorizationContext,
  ): Promise<AdminJobOpeningsResponse> {
    authorization.assertCorporate('careers.view');
    const where: Prisma.JobOpeningWhereInput = {};
    if (status !== undefined) {
      where.status = this.parseStatusFilter(status);
    }
    const jobs = await this.prisma.jobOpening.findMany({
      where,
      include: JOB_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    return { jobs: jobs.map(toAdminJobOpening) };
  }

  async getOptions(
    authorization: AuthorizationContext,
  ): Promise<AdminJobOpeningOptions> {
    authorization.assertCorporate('careers.view');
    const locations = await this.prisma.location.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return { locations, employmentTypes: [...EMPLOYMENT_TYPES] };
  }

  async getDetail(
    jobId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminJobOpening> {
    authorization.assertCorporate('careers.view');
    return toAdminJobOpening(await this.loadOrThrow(jobId));
  }

  async create(
    request: CreateJobOpeningRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminJobOpening> {
    authorization.assertCorporate('careers.manage');

    const data = {
      title: this.validateShort(request?.title, 'title', JOB_OPENING_TITLE_MAX_LENGTH),
      summary: this.validateShort(
        request?.summary,
        'summary',
        JOB_OPENING_SUMMARY_MAX_LENGTH,
      ),
      description: this.validateLong(request?.description, 'description'),
      responsibilities: this.validateLong(
        request?.responsibilities,
        'responsibilities',
      ),
      qualifications: this.validateLong(
        request?.qualifications,
        'qualifications',
      ),
      employmentType: this.validateEmploymentType(request?.employmentType),
      locationId: await this.validateLocationId(request?.locationId),
    };

    const created = await this.prisma.$transaction(async (tx) => {
      const job = await tx.jobOpening.create({ data, include: JOB_INCLUDE });
      await this.audit.recordJobOpeningCreated(tx, {
        actorInternalUserId,
        jobOpeningId: job.id,
        snapshot: this.auditSnapshot(job),
      });
      return job;
    });
    return toAdminJobOpening(created);
  }

  async update(
    jobId: string,
    request: UpdateJobOpeningRequest,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminJobOpening> {
    authorization.assertCorporate('careers.manage');
    const current = await this.loadOrThrow(jobId);
    if (current.status === 'ARCHIVED') {
      throw new ConflictException('An archived job opening cannot be edited.');
    }

    // Reject a status write smuggled through PATCH.
    if (
      request !== null &&
      typeof request === 'object' &&
      ('status' in request || 'publishedAt' in request)
    ) {
      throw new BadRequestException(
        "A job opening's status is changed only through publish / unpublish / archive.",
      );
    }

    const data: Prisma.JobOpeningUpdateInput = {};
    if (request?.title !== undefined) {
      data.title = this.validateShort(
        request.title,
        'title',
        JOB_OPENING_TITLE_MAX_LENGTH,
      );
    }
    if (request?.summary !== undefined) {
      data.summary = this.validateShort(
        request.summary,
        'summary',
        JOB_OPENING_SUMMARY_MAX_LENGTH,
      );
    }
    if (request?.description !== undefined) {
      data.description = this.validateLong(request.description, 'description');
    }
    if (request?.responsibilities !== undefined) {
      data.responsibilities = this.validateLong(
        request.responsibilities,
        'responsibilities',
      );
    }
    if (request?.qualifications !== undefined) {
      data.qualifications = this.validateLong(
        request.qualifications,
        'qualifications',
      );
    }
    if (request?.employmentType !== undefined) {
      data.employmentType = this.validateEmploymentType(request.employmentType);
    }
    if (request?.locationId !== undefined) {
      const locationId = await this.validateLocationId(request.locationId);
      data.location = locationId
        ? { connect: { id: locationId } }
        : { disconnect: true };
    }

    if (Object.keys(data).length === 0) {
      return toAdminJobOpening(current);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const job = await tx.jobOpening.update({
        where: { id: jobId },
        data,
        include: JOB_INCLUDE,
      });
      await this.audit.recordJobOpeningUpdated(tx, {
        actorInternalUserId,
        jobOpeningId: jobId,
        before: this.auditSnapshot(current),
        after: this.auditSnapshot(job),
      });
      return job;
    });
    return toAdminJobOpening(updated);
  }

  publish(
    jobId: string,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminJobOpening> {
    return this.transition(jobId, 'published', actorInternalUserId, authorization);
  }

  unpublish(
    jobId: string,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminJobOpening> {
    return this.transition(
      jobId,
      'unpublished',
      actorInternalUserId,
      authorization,
    );
  }

  archive(
    jobId: string,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminJobOpening> {
    return this.transition(jobId, 'archived', actorInternalUserId, authorization);
  }

  // --- transitions ---------------------------------------------

  private async transition(
    jobId: string,
    change: 'published' | 'unpublished' | 'archived',
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminJobOpening> {
    authorization.assertCorporate('careers.manage');
    const current = await this.loadOrThrow(jobId);

    const nextStatus = this.assertTransitionAllowed(current.status, change);
    const data: Prisma.JobOpeningUpdateInput = { status: nextStatus };
    if (change === 'published' && current.publishedAt === null) {
      data.publishedAt = new Date();
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const job = await tx.jobOpening.update({
        where: { id: jobId },
        data,
        include: JOB_INCLUDE,
      });
      await this.audit.recordJobOpeningStatusChanged(tx, {
        actorInternalUserId,
        jobOpeningId: jobId,
        change,
        before: {
          status: current.status,
          publishedAt: current.publishedAt?.toISOString() ?? null,
        },
        after: {
          status: job.status,
          publishedAt: job.publishedAt?.toISOString() ?? null,
        },
      });
      return job;
    });
    return toAdminJobOpening(updated);
  }

  private assertTransitionAllowed(
    from: JobOpeningStatus,
    change: 'published' | 'unpublished' | 'archived',
  ): JobOpeningStatus {
    if (from === 'ARCHIVED') {
      throw new ConflictException(
        'An archived job opening is final and cannot change status.',
      );
    }
    if (change === 'published') {
      if (from !== 'DRAFT') {
        throw new ConflictException('Only a draft job opening can be published.');
      }
      return 'PUBLISHED';
    }
    if (change === 'unpublished') {
      if (from !== 'PUBLISHED') {
        throw new ConflictException(
          'Only a published job opening can be unpublished.',
        );
      }
      return 'DRAFT';
    }
    // archived — allowed from DRAFT or PUBLISHED (handled by the ARCHIVED
    // guard above).
    return 'ARCHIVED';
  }

  // --- helpers -------------------------------------------------

  private async loadOrThrow(jobId: string): Promise<JobOpeningRow> {
    const job = await this.prisma.jobOpening.findUnique({
      where: { id: jobId },
      include: JOB_INCLUDE,
    });
    if (!job) {
      throw new NotFoundException('Job opening not found.');
    }
    return job;
  }

  private parseStatusFilter(raw: string): JobOpeningStatus {
    if (raw === 'DRAFT' || raw === 'PUBLISHED' || raw === 'ARCHIVED') {
      return raw;
    }
    throw new BadRequestException(
      'status must be DRAFT, PUBLISHED or ARCHIVED.',
    );
  }

  private validateShort(raw: unknown, field: string, max: number): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new BadRequestException(`A job ${field} is required.`);
    }
    const value = raw.trim();
    if (value.length > max) {
      throw new BadRequestException(
        `The job ${field} must be at most ${max} characters.`,
      );
    }
    return value;
  }

  private validateLong(raw: unknown, field: string): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new BadRequestException(`Job ${field} are required.`);
    }
    const value = raw.trim();
    if (value.length > JOB_OPENING_LONG_TEXT_MAX_LENGTH) {
      throw new BadRequestException(
        `Job ${field} must be at most ${JOB_OPENING_LONG_TEXT_MAX_LENGTH} characters.`,
      );
    }
    return value;
  }

  private validateEmploymentType(raw: unknown): JobEmploymentType {
    if (
      typeof raw === 'string' &&
      (EMPLOYMENT_TYPES as readonly string[]).includes(raw)
    ) {
      return raw as JobEmploymentType;
    }
    throw new BadRequestException(
      `employmentType must be one of ${EMPLOYMENT_TYPES.join(', ')}.`,
    );
  }

  private async validateLocationId(
    raw: unknown,
  ): Promise<string | null> {
    if (raw === undefined || raw === null || raw === '') {
      return null; // corporate / HQ
    }
    if (typeof raw !== 'string') {
      throw new BadRequestException('locationId must be a string or null.');
    }
    const location = await this.prisma.location.findUnique({
      where: { id: raw },
      select: { id: true },
    });
    if (!location) {
      throw new BadRequestException('That location does not exist.');
    }
    return location.id;
  }

  private auditSnapshot(row: JobOpeningRow): Prisma.InputJsonValue {
    return {
      title: row.title,
      employmentType: row.employmentType,
      locationId: row.locationId,
      summary: row.summary,
      description: row.description,
      responsibilities: row.responsibilities,
      qualifications: row.qualifications,
      status: row.status,
    };
  }
}
