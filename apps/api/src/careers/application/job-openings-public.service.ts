import { Injectable, NotFoundException } from '@nestjs/common';
import type {
  PublicJobOpeningDetail,
  PublicJobOpeningsResponse,
} from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import type { TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import {
  isPubliclyVisible,
  toPublicJobOpeningDetail,
  toPublicJobOpeningSummary,
} from './job-opening-mapper';

const JOB_INCLUDE = {
  location: { select: { id: true, name: true, isActive: true } },
} satisfies Prisma.JobOpeningInclude;

// The PUBLIC Careers surface (Milestone 8B). No auth. A job is visible only
// when it is PUBLISHED and either corporate (no location) or tied to an
// active Location. A non-visible job — draft, archived, tied to an inactive
// location, or simply unknown — returns 404 from the detail endpoint: the
// existence of a non-public job is never revealed.
@Injectable()
export class JobOpeningsPublicService {
  constructor(private readonly prisma: PrismaService) {}

  // Public storefront reads (S3P): only the storefront business's own
  // jobs. Another business's job — published or not — is reported exactly
  // like a missing one.
  async list(tenant: TenantContext): Promise<PublicJobOpeningsResponse> {
    // Narrow at the DB where we can (status + active/absent location), then
    // apply the exact visibility rule in the mapper.
    const jobs = await this.prisma.jobOpening.findMany({
      where: {
        tenantId: tenant.tenantId,
        status: 'PUBLISHED',
        OR: [{ locationId: null }, { location: { isActive: true } }],
      },
      include: JOB_INCLUDE,
      orderBy: [{ publishedAt: 'desc' }, { createdAt: 'desc' }],
    });
    return {
      jobs: jobs.filter(isPubliclyVisible).map(toPublicJobOpeningSummary),
    };
  }

  async getDetail(
    jobId: string,
    tenant: TenantContext,
  ): Promise<PublicJobOpeningDetail> {
    const job =
      typeof jobId === 'string'
        ? await this.prisma.jobOpening.findFirst({
            where: { id: jobId, tenantId: tenant.tenantId },
            include: JOB_INCLUDE,
          })
        : null;

    if (!job || !isPubliclyVisible(job)) {
      throw new NotFoundException('Job opening not found.');
    }
    return toPublicJobOpeningDetail(job);
  }
}
