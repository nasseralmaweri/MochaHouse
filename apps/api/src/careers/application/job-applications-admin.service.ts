import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AdminJobApplicationDetail,
  AdminJobApplicationSummary,
  AdminJobApplicationsResponse,
  JobApplicationStatus,
} from '@mocha-house/contracts';
import { JOB_APPLICATION_STATUSES } from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { JobApplicationNotesService } from './job-application-notes.service';
import { toJobApplicationActivityItem } from './job-application-activity';

const LIST_PAGE_SIZE = 25;
const ACTIVITY_LIMIT = 30;

type ApplicationRow = Prisma.JobApplicationGetPayload<{
  include: { jobOpening: { select: { status: true } } };
}>;

// HQ view + narrow management of job applications (Milestone 8C).
// `applicants.view` / `applicants.manage` are CORPORATE-only — candidate
// PII must never reach a Store Manager / location-scoped role.
// PermissionGuard rejects a LOCATION grant and every method also calls
// assertCorporate. Status changes go through the ONE dedicated action
// (any valid status → any valid status; no transition graph, no PATCH).
@Injectable()
export class JobApplicationsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
    private readonly notes: JobApplicationNotesService,
  ) {}

  async list(
    query: { status?: string; jobOpeningId?: string; cursor?: string },
    authorization: AuthorizationContext,
  ): Promise<AdminJobApplicationsResponse> {
    authorization.assertCorporate('applicants.view');

    const where: Prisma.JobApplicationWhereInput = {};
    if (query.status !== undefined) {
      where.status = this.parseStatus(query.status);
    }
    if (typeof query.jobOpeningId === 'string' && query.jobOpeningId.length > 0) {
      where.jobOpeningId = query.jobOpeningId;
    }
    if (typeof query.cursor === 'string' && query.cursor.length > 0) {
      // JobApplication.id is a uuid7 — id-desc is monotonic with createdAt.
      where.id = { lt: query.cursor };
    }

    const rows = await this.prisma.jobApplication.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIST_PAGE_SIZE + 1,
    });
    const hasMore = rows.length > LIST_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, LIST_PAGE_SIZE) : rows;

    return {
      applications: page.map((row) => this.toSummary(row)),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  async getDetail(
    applicationId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminJobApplicationDetail> {
    authorization.assertCorporate('applicants.view');
    const application = await this.loadOrThrow(applicationId);

    const [notes, activityRows] = await Promise.all([
      this.notes.load(applicationId),
      this.prisma.internalAuditEvent.findMany({
        where: { targetType: 'job_application', targetId: applicationId },
        orderBy: { createdAt: 'desc' },
        take: ACTIVITY_LIMIT,
        select: {
          id: true,
          action: true,
          createdAt: true,
          beforeData: true,
          afterData: true,
          actorInternalUser: { select: { displayName: true, email: true } },
        },
      }),
    ]);

    return {
      id: application.id,
      status: application.status,
      jobOpeningId: application.jobOpeningId,
      jobTitleSnapshot: application.jobTitleSnapshot,
      jobStatus: application.jobOpening?.status ?? null,
      firstName: application.firstName,
      lastName: application.lastName,
      email: application.email,
      phone: application.phone,
      location: application.location,
      workAuthorized: application.workAuthorized,
      availability: application.availability,
      message: application.message,
      resumeUrl: application.resumeUrl,
      createdAt: application.createdAt.toISOString(),
      updatedAt: application.updatedAt.toISOString(),
      notes,
      activity: activityRows.map(toJobApplicationActivityItem),
    };
  }

  async updateStatus(
    applicationId: string,
    rawStatus: unknown,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminJobApplicationDetail> {
    authorization.assertCorporate('applicants.manage');
    const current = await this.loadOrThrow(applicationId);
    const next = this.parseStatus(rawStatus);

    if (next === current.status) {
      return this.getDetail(applicationId, authorization);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.jobApplication.update({
        where: { id: applicationId },
        data: { status: next },
      });
      await this.audit.recordJobApplicationStatusChanged(tx, {
        actorInternalUserId,
        jobApplicationId: applicationId,
        before: current.status,
        after: next,
      });
    });

    return this.getDetail(applicationId, authorization);
  }

  private async loadOrThrow(applicationId: string): Promise<ApplicationRow> {
    const application = await this.prisma.jobApplication.findUnique({
      where: { id: applicationId },
      include: { jobOpening: { select: { status: true } } },
    });
    if (!application) {
      throw new NotFoundException('Application not found.');
    }
    return application;
  }

  private parseStatus(raw: unknown): JobApplicationStatus {
    if (
      typeof raw === 'string' &&
      (JOB_APPLICATION_STATUSES as readonly string[]).includes(raw)
    ) {
      return raw as JobApplicationStatus;
    }
    throw new BadRequestException(
      `status must be one of ${JOB_APPLICATION_STATUSES.join(', ')}.`,
    );
  }

  private toSummary(
    row: Prisma.JobApplicationGetPayload<Record<string, never>>,
  ): AdminJobApplicationSummary {
    return {
      id: row.id,
      applicantName: `${row.firstName} ${row.lastName}`.trim(),
      email: row.email,
      jobOpeningId: row.jobOpeningId,
      jobTitleSnapshot: row.jobTitleSnapshot,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
