import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  AdminApprovalRequest,
  AdminApprovalRequestsResponse,
  ApprovalStatus,
} from '@mocha-house/contracts';
import { APPROVAL_TARGET_TYPE_CAMPAIGN } from '@mocha-house/contracts';
import { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';

const LIST_PAGE_SIZE = 25;
const REASON_MAX_LENGTH = 1000;

const REQUEST_INCLUDE = {
  requestedByInternalUser: { select: { displayName: true, email: true } },
  decidedByInternalUser: { select: { displayName: true, email: true } },
} satisfies Prisma.ApprovalRequestInclude;

type ApprovalRequestRow = Prisma.ApprovalRequestGetPayload<{
  include: typeof REQUEST_INCLUDE;
}>;

// Milestone 8J — HQ decisions over pending ApprovalRequest rows.
// `approvals.view` / `approvals.decide` are CORPORATE-only; every method
// also calls assertCorporate. This slice wires exactly ONE target type
// (Campaign — see APPROVAL_TARGET_TYPE_CAMPAIGN), so every method here
// ALSO requires `marketing.view`: a decider who can't see the campaign
// itself must never be able to approve or reject it. This is an explicit,
// per-target-type rule, not a generic cross-domain permission framework —
// when a second target type is ever wired, its own equivalent visibility
// requirement gets added here the same way.
@Injectable()
export class ApprovalsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
  ) {}

  async list(
    query: { status?: string; cursor?: string },
    authorization: AuthorizationContext,
  ): Promise<AdminApprovalRequestsResponse> {
    authorization.assertCorporate('approvals.view');
    authorization.assertCorporate('marketing.view');

    const where: Prisma.ApprovalRequestWhereInput = {};
    if (query.status !== undefined) {
      where.status = this.parseStatus(query.status);
    }
    if (typeof query.cursor === 'string' && query.cursor.length > 0) {
      where.id = { lt: query.cursor };
    }

    const rows = await this.prisma.approvalRequest.findMany({
      where,
      include: REQUEST_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIST_PAGE_SIZE + 1,
    });
    const hasMore = rows.length > LIST_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, LIST_PAGE_SIZE) : rows;

    const approvalRequests = await Promise.all(
      page.map((row) => this.toAdminApprovalRequest(row)),
    );

    return {
      approvalRequests,
      nextCursor: hasMore ? page[page.length - 1]!.id : null,
    };
  }

  async getOne(
    approvalRequestId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminApprovalRequest> {
    authorization.assertCorporate('approvals.view');
    authorization.assertCorporate('marketing.view');
    return this.toAdminApprovalRequest(await this.loadOrThrow(approvalRequestId));
  }

  async approve(
    approvalRequestId: string,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminApprovalRequest> {
    authorization.assertCorporate('approvals.decide');
    authorization.assertCorporate('marketing.view');

    const current = await this.loadOrThrow(approvalRequestId);
    if (current.status !== 'PENDING') {
      throw new ConflictException('Only a pending approval request can be approved.');
    }
    if (current.requestedByInternalUserId === actorInternalUserId) {
      throw new ForbiddenException('You cannot approve your own request.');
    }

    const decidedAt = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.approvalRequest.update({
        where: { id: approvalRequestId },
        data: {
          status: 'APPROVED',
          decidedByInternalUserId: actorInternalUserId,
          decidedAt,
        },
        include: REQUEST_INCLUDE,
      });
      await this.audit.recordApprovalApproved(tx, {
        actorInternalUserId,
        approvalRequestId,
        targetType: current.targetType,
        targetId: current.targetId,
        action: current.action,
      });
      return row;
    });

    return this.toAdminApprovalRequest(updated);
  }

  async reject(
    approvalRequestId: string,
    reason: unknown,
    actorInternalUserId: string,
    authorization: AuthorizationContext,
  ): Promise<AdminApprovalRequest> {
    authorization.assertCorporate('approvals.decide');
    authorization.assertCorporate('marketing.view');

    const validReason = this.validateReason(reason);

    const current = await this.loadOrThrow(approvalRequestId);
    if (current.status !== 'PENDING') {
      throw new ConflictException('Only a pending approval request can be rejected.');
    }
    if (current.requestedByInternalUserId === actorInternalUserId) {
      throw new ForbiddenException('You cannot reject your own request.');
    }

    const decidedAt = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const row = await tx.approvalRequest.update({
        where: { id: approvalRequestId },
        data: {
          status: 'REJECTED',
          decidedByInternalUserId: actorInternalUserId,
          decisionReason: validReason,
          decidedAt,
        },
        include: REQUEST_INCLUDE,
      });
      await this.audit.recordApprovalRejected(tx, {
        actorInternalUserId,
        approvalRequestId,
        targetType: current.targetType,
        targetId: current.targetId,
        action: current.action,
        reason: validReason,
      });
      return row;
    });

    return this.toAdminApprovalRequest(updated);
  }

  // --- helpers -------------------------------------------------

  private async loadOrThrow(approvalRequestId: string): Promise<ApprovalRequestRow> {
    const row = await this.prisma.approvalRequest.findUnique({
      where: { id: approvalRequestId },
      include: REQUEST_INCLUDE,
    });
    if (!row) {
      throw new NotFoundException('Approval request not found.');
    }
    return row;
  }

  private parseStatus(raw: string): ApprovalStatus {
    if (raw === 'PENDING' || raw === 'APPROVED' || raw === 'REJECTED') {
      return raw;
    }
    throw new BadRequestException('status must be PENDING, APPROVED or REJECTED.');
  }

  private validateReason(raw: unknown): string {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new BadRequestException('A reason is required.');
    }
    const reason = raw.trim();
    if (reason.length > REASON_MAX_LENGTH) {
      throw new BadRequestException(
        `Reason is too long (maximum ${REASON_MAX_LENGTH} characters).`,
      );
    }
    return reason;
  }

  private async toAdminApprovalRequest(
    row: ApprovalRequestRow,
  ): Promise<AdminApprovalRequest> {
    return {
      id: row.id,
      targetType: row.targetType,
      targetId: row.targetId,
      targetLabel: await this.resolveTargetLabel(row.targetType, row.targetId),
      action: row.action,
      status: row.status,
      requestedByLabel:
        row.requestedByInternalUser.displayName ?? row.requestedByInternalUser.email,
      createdAt: row.createdAt.toISOString(),
      decidedByLabel: row.decidedByInternalUser
        ? row.decidedByInternalUser.displayName ?? row.decidedByInternalUser.email
        : null,
      decisionReason: row.decisionReason,
      decidedAt: row.decidedAt?.toISOString() ?? null,
    };
  }

  // Only ONE target type is wired in 8J. Resolving a label here (rather
  // than storing one on ApprovalRequest at request time) always reflects
  // the campaign's CURRENT name — deliberately, matching the same
  // "never snapshot, always read live" choice CmsPage/Campaign
  // reference-checks already make elsewhere in this codebase.
  private async resolveTargetLabel(
    targetType: string,
    targetId: string,
  ): Promise<string> {
    if (targetType === APPROVAL_TARGET_TYPE_CAMPAIGN) {
      const campaign = await this.prisma.campaign.findUnique({
        where: { id: targetId },
        select: { name: true },
      });
      return campaign?.name ?? 'Deleted campaign';
    }
    return `${targetType} ${targetId}`;
  }
}
