import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AdminFranchiseInquiryDetail,
  AdminFranchiseInquirySummary,
  AdminFranchiseInquiriesResponse,
  FranchiseInquiryStatus,
} from '@mocha-house/contracts';
import { FRANCHISE_INQUIRY_STATUSES } from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { FranchiseInquiryNotesService } from './franchise-inquiry-notes.service';
import { toFranchiseInquiryActivityItem } from './franchise-inquiry-activity';

const LIST_PAGE_SIZE = 25;
const ACTIVITY_LIMIT = 30;

type InquiryRow = Prisma.FranchiseInquiryGetPayload<Record<string, never>>;

// HQ view + narrow management of franchise inquiries (Milestone 8D).
// `franchising.view` / `franchising.manage` are CORPORATE-only — prospect
// PII must never reach a Store Manager / location-scoped role.
// PermissionGuard rejects a LOCATION grant and every method also calls
// assertCorporate. Status changes go through the ONE dedicated action
// (any valid status → any valid status; no transition graph, no PATCH).
@Injectable()
export class FranchiseInquiriesAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
    private readonly notes: FranchiseInquiryNotesService,
  ) {}

  async list(
    query: { status?: string; cursor?: string },
    authorization: AuthorizationContext,
  ): Promise<AdminFranchiseInquiriesResponse> {
    authorization.assertCorporate('franchising.view');

    const where: Prisma.FranchiseInquiryWhereInput = {};
    if (query.status !== undefined) {
      where.status = this.parseStatus(query.status);
    }
    if (typeof query.cursor === 'string' && query.cursor.length > 0) {
      // FranchiseInquiry.id is a uuid7 — id-desc is monotonic with createdAt.
      where.id = { lt: query.cursor };
    }

    const rows = await this.prisma.franchiseInquiry.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIST_PAGE_SIZE + 1,
    });
    const hasMore = rows.length > LIST_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, LIST_PAGE_SIZE) : rows;

    return {
      inquiries: page.map((row) => this.toSummary(row)),
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  async getDetail(
    inquiryId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminFranchiseInquiryDetail> {
    authorization.assertCorporate('franchising.view');
    const inquiry = await this.loadOrThrow(inquiryId);

    const [notes, activityRows] = await Promise.all([
      this.notes.load(inquiryId),
      this.prisma.internalAuditEvent.findMany({
        where: { targetType: 'franchise_inquiry', targetId: inquiryId },
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
      id: inquiry.id,
      status: inquiry.status,
      firstName: inquiry.firstName,
      lastName: inquiry.lastName,
      email: inquiry.email,
      phone: inquiry.phone,
      city: inquiry.city,
      state: inquiry.state,
      country: inquiry.country,
      preferredMarket: inquiry.preferredMarket,
      investmentRange: inquiry.investmentRange,
      timeframe: inquiry.timeframe,
      businessExperience: inquiry.businessExperience,
      message: inquiry.message,
      consentAcknowledged: inquiry.consentAcknowledged,
      createdAt: inquiry.createdAt.toISOString(),
      updatedAt: inquiry.updatedAt.toISOString(),
      notes,
      activity: activityRows.map(toFranchiseInquiryActivityItem),
    };
  }

  async updateStatus(
    inquiryId: string,
    rawStatus: unknown,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminFranchiseInquiryDetail> {
    authorization.assertCorporate('franchising.manage');
    const current = await this.loadOrThrow(inquiryId);
    const next = this.parseStatus(rawStatus);

    if (next === current.status) {
      return this.getDetail(inquiryId, authorization);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.franchiseInquiry.update({
        where: { id: inquiryId },
        data: { status: next },
      });
      await this.audit.recordFranchiseInquiryStatusChanged(tx, {
        actorInternalUserId,
        franchiseInquiryId: inquiryId,
        before: current.status,
        after: next,
      });
    });

    return this.getDetail(inquiryId, authorization);
  }

  private async loadOrThrow(inquiryId: string): Promise<InquiryRow> {
    const inquiry = await this.prisma.franchiseInquiry.findUnique({
      where: { id: inquiryId },
    });
    if (!inquiry) {
      throw new NotFoundException('Franchise inquiry not found.');
    }
    return inquiry;
  }

  private parseStatus(raw: unknown): FranchiseInquiryStatus {
    if (
      typeof raw === 'string' &&
      (FRANCHISE_INQUIRY_STATUSES as readonly string[]).includes(raw)
    ) {
      return raw as FranchiseInquiryStatus;
    }
    throw new BadRequestException(
      `status must be one of ${FRANCHISE_INQUIRY_STATUSES.join(', ')}.`,
    );
  }

  private toSummary(row: InquiryRow): AdminFranchiseInquirySummary {
    return {
      id: row.id,
      prospectName: `${row.firstName} ${row.lastName}`.trim(),
      email: row.email,
      preferredMarket: row.preferredMarket,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
