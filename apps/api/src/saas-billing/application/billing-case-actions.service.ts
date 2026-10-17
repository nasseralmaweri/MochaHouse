import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  BILLING_CASE_NOT_RELEASABLE,
  BILLING_CASE_SCHEDULE_MISMATCH,
  BILLING_UNAVAILABLE,
  PLATFORM_CASE_OUTCOMES,
  type PlatformCaseCloseRequest,
  type PlatformCaseDetailResponse,
  type PlatformCaseOutcome,
  type PlatformCaseRecheckResponse,
  type PlatformReconciliationCase,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { runSerializable } from '../../prisma/serializable-transaction';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import type { PlatformOperatorRow } from '../../platform-auth/infrastructure/platform-identity';
import { isUuid } from '../../platform-subscriptions/application/plan-input';
import {
  SAAS_BILLING_PROVIDER,
  SaasBillingProviderError,
  type SaasBillingProvider,
} from '../provider/saas-billing-provider';
import { BillingReconciliationService } from './billing-reconciliation.service';
import { parseReason } from './billing-complimentary.service';

// SC3e-2 (owner decision D5) — what an operator may do with a billing review
// case, each step in the case's append-only action history and the platform
// audit trail:
//   * RECHECK (billing.cases.manage): the provider is read again for the
//     case's subscription and our checks re-run (state, payment method,
//     cancellation, invoices, a scheduled complimentary grant). No provider
//     write; nothing the provider holds is adopted;
//   * RELEASE a leftover schedule (billing.schedules.release, a recent
//     sign-in and a written reason): only THE schedule attached to the
//     case's own subscription right now — the operator names it, and it must
//     match what the provider holds; never one an open scheduled plan change
//     still holds (the business cancels that one). RELEASED, never
//     cancelled (cancelling a schedule cancels the subscription); one
//     idempotency key per case and schedule;
//   * CLOSE (billing.cases.manage) with an outcome code and a note.
// Never a refund, a credit or an adopted price.

function conflict(code: string, message: string): ConflictException {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code,
    message,
  });
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    statusCode: 503,
    error: 'Service Unavailable',
    code: BILLING_UNAVAILABLE,
    message: 'The payment provider is not available. Nothing was changed.',
  });
}

export function parseCloseRequest(body: unknown): PlatformCaseCloseRequest {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).sort().join(',') !== 'note,outcome'
  ) {
    throw new BadRequestException('Send exactly { outcome, note }.');
  }
  const { outcome, note } = body as { outcome: unknown; note: unknown };
  if (!PLATFORM_CASE_OUTCOMES.includes(outcome as PlatformCaseOutcome)) {
    throw new BadRequestException(
      `outcome must be one of: ${PLATFORM_CASE_OUTCOMES.join(', ')}.`,
    );
  }
  return { outcome: outcome as PlatformCaseOutcome, note: parseReason(note) };
}

export function parseReleaseRequest(body: unknown): {
  externalScheduleId: string;
  reason: string;
} {
  if (
    typeof body !== 'object' ||
    body === null ||
    Array.isArray(body) ||
    Object.keys(body).sort().join(',') !== 'externalScheduleId,reason'
  ) {
    throw new BadRequestException(
      'Send exactly { externalScheduleId, reason }.',
    );
  }
  const { externalScheduleId, reason } = body as {
    externalScheduleId: unknown;
    reason: unknown;
  };
  if (
    typeof externalScheduleId !== 'string' ||
    !/^[A-Za-z0-9_]{1,255}$/.test(externalScheduleId)
  ) {
    throw new BadRequestException('Name the schedule to release.');
  }
  return { externalScheduleId, reason: parseReason(reason) };
}

@Injectable()
export class BillingCaseActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reconciliation: BillingReconciliationService,
    @Inject(SAAS_BILLING_PROVIDER)
    private readonly provider: SaasBillingProvider,
  ) {}

  private async loadCase(caseId: string) {
    if (!isUuid(caseId)) throw new NotFoundException('Case not found.');
    const row = await this.prisma.billingReconciliationCase.findUnique({
      where: { id: caseId },
      include: {
        subscription: { include: { subscriberTenant: true } },
        billingProviderEvent: {
          select: { subscription: { include: { subscriberTenant: true } } },
        },
        actions: {
          orderBy: { createdAt: 'asc' },
          include: { actor: { select: { id: true, email: true } } },
        },
      },
    });
    if (!row) throw new NotFoundException('Case not found.');
    return row;
  }

  async detail(caseId: string): Promise<PlatformCaseDetailResponse> {
    const row = await this.loadCase(caseId);
    const subscription =
      row.subscription ?? row.billingProviderEvent?.subscription ?? null;
    const view: PlatformReconciliationCase = {
      id: row.id,
      kind: row.kind,
      tenantId: subscription?.subscriberTenant.id ?? null,
      businessName: subscription?.subscriberTenant.name ?? null,
      detail: row.detail,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
      resolutionOutcome: row.resolutionOutcome as PlatformCaseOutcome | null,
      resolutionNote: row.resolutionNote,
    };
    let provider: PlatformCaseDetailResponse['provider'] = null;
    let providerUnavailable = false;
    if (
      row.subscription &&
      row.subscription.billingMode === 'BILLED' &&
      row.subscription.externalSubscriptionId !== null &&
      row.subscription.billingProvider === this.provider.name
    ) {
      try {
        const snapshot = await this.provider.retrieveSubscription(
          row.subscription.externalSubscriptionId,
        );
        const scheduleId = snapshot.scheduleId ?? null;
        const schedule = scheduleId
          ? await this.provider.retrieveSchedule(scheduleId)
          : null;
        provider = {
          schedule: schedule
            ? {
                externalScheduleId: schedule.externalScheduleId,
                status: schedule.status,
              }
            : null,
          scheduleIsOpenPlanChange:
            scheduleId !== null &&
            (await this.prisma.billingPlanChange.count({
              where: { externalScheduleId: scheduleId, status: 'SCHEDULED' },
            })) > 0,
        };
      } catch (error) {
        if (!(error instanceof SaasBillingProviderError)) throw error;
        providerUnavailable = true;
      }
    }
    return {
      case: view,
      actions: row.actions.map((action) => ({
        action: action.action as 'RECHECKED' | 'SCHEDULE_RELEASED' | 'CLOSED',
        result: action.result,
        note: action.note,
        externalScheduleId: action.externalScheduleId,
        actor: action.actor,
        at: action.createdAt.toISOString(),
      })),
      provider,
      providerUnavailable,
    };
  }

  async recheck(
    caseId: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformCaseRecheckResponse> {
    const row = await this.loadCase(caseId);
    const subscription = row.subscription;
    let result: PlatformCaseRecheckResponse['result'];
    let opened: string[] = [];
    if (
      !subscription ||
      subscription.billingMode !== 'BILLED' ||
      subscription.externalSubscriptionId === null ||
      subscription.billingProvider !== this.provider.name ||
      !this.provider.available
    ) {
      result = 'PROVIDER_UNAVAILABLE';
    } else {
      const checked = await this.reconciliation.checkSubscription(subscription);
      opened = checked.opened;
      result = checked.providerUnavailable
        ? 'PROVIDER_UNAVAILABLE'
        : opened.length > 0
          ? 'MISMATCH_FOUND'
          : 'CONSISTENT';
    }
    await runSerializable(this.prisma, async (tx) => {
      await tx.billingReconciliationCaseAction.create({
        data: {
          caseId: row.id,
          action: 'RECHECKED',
          result,
          actorPlatformOperatorId: operator.id,
        },
      });
      await tx.platformAuditEvent.create({
        data: {
          action: PLATFORM_AUDIT_ACTIONS.billingCaseRechecked,
          outcome: 'SUCCEEDED',
          actorPlatformOperatorId: operator.id,
          reasonCode: result,
          targetType: 'billing_case',
          targetId: row.id,
          requestReference: requestReference ?? null,
        },
      });
    });
    return { result, openCases: opened };
  }

  async releaseSchedule(
    caseId: string,
    input: { externalScheduleId: string; reason: string },
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformCaseDetailResponse> {
    const row = await this.loadCase(caseId);
    const subscription = row.subscription;
    if (
      row.status !== 'OPEN' ||
      !subscription ||
      subscription.billingMode !== 'BILLED' ||
      subscription.externalSubscriptionId === null
    ) {
      throw conflict(
        BILLING_CASE_NOT_RELEASABLE,
        'This case has no open subscription whose schedule can be released.',
      );
    }
    if (
      !this.provider.available ||
      subscription.billingProvider !== this.provider.name
    ) {
      throw unavailable();
    }
    const externalSubscriptionId = subscription.externalSubscriptionId;
    try {
      const snapshot = await this.provider.retrieveSubscription(
        externalSubscriptionId,
      );
      if (
        snapshot.externalSubscriptionId !== externalSubscriptionId ||
        snapshot.externalCustomerId !== subscription.externalCustomerId ||
        snapshot.livemode !== this.provider.livemode ||
        (snapshot.scheduleId ?? null) !== input.externalScheduleId
      ) {
        throw conflict(
          BILLING_CASE_SCHEDULE_MISMATCH,
          'That schedule is not the one attached to this business’s subscription now. Reload the case.',
        );
      }
      const schedule = await this.provider.retrieveSchedule(
        input.externalScheduleId,
      );
      if (
        schedule === null ||
        schedule.livemode !== this.provider.livemode ||
        schedule.externalSubscriptionId !== externalSubscriptionId ||
        !(schedule.status === 'active' || schedule.status === 'not_started')
      ) {
        throw conflict(
          BILLING_CASE_NOT_RELEASABLE,
          'That schedule is not active on this subscription.',
        );
      }
      if (
        (await this.prisma.billingPlanChange.count({
          where: {
            OR: [
              {
                externalScheduleId: input.externalScheduleId,
                status: 'SCHEDULED',
              },
              {
                subscriptionId: subscription.id,
                status: { in: ['REQUESTED', 'AWAITING_PAYMENT'] },
              },
            ],
          },
        })) > 0
      ) {
        throw conflict(
          BILLING_CASE_NOT_RELEASABLE,
          'A plan change holds this schedule or is in progress on the subscription; the business cancels it from its billing page.',
        );
      }
      const released = await this.provider.releaseSchedule({
        idempotencyKey: `centerivo-case-${row.id}-release-${input.externalScheduleId}`,
        externalScheduleId: input.externalScheduleId,
      });
      if (released.releasedSubscriptionId !== externalSubscriptionId) {
        throw new SaasBillingProviderError('release_unexpected');
      }
    } catch (error) {
      if (error instanceof SaasBillingProviderError) throw unavailable();
      throw error;
    }
    await runSerializable(this.prisma, async (tx) => {
      await tx.billingReconciliationCaseAction.create({
        data: {
          caseId: row.id,
          action: 'SCHEDULE_RELEASED',
          result: 'RELEASED',
          note: input.reason,
          externalScheduleId: input.externalScheduleId,
          actorPlatformOperatorId: operator.id,
        },
      });
      await tx.platformAuditEvent.create({
        data: {
          action: PLATFORM_AUDIT_ACTIONS.billingScheduleReleased,
          outcome: 'SUCCEEDED',
          actorPlatformOperatorId: operator.id,
          reasonCode: 'RELEASED',
          targetType: 'billing_case',
          targetId: row.id,
          requestReference: requestReference ?? null,
        },
      });
    });
    return this.detail(row.id);
  }

  async close(
    caseId: string,
    input: PlatformCaseCloseRequest,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformCaseDetailResponse> {
    if (!isUuid(caseId)) throw new NotFoundException('Case not found.');
    await runSerializable(this.prisma, async (tx) => {
      const { count } = await tx.billingReconciliationCase.updateMany({
        where: { id: caseId, status: 'OPEN' },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolvedByPlatformOperatorId: operator.id,
          resolutionOutcome: input.outcome,
          resolutionNote: input.note,
        },
      });
      if (count !== 1) {
        const exists = await tx.billingReconciliationCase.findUnique({
          where: { id: caseId },
          select: { id: true },
        });
        if (!exists) throw new NotFoundException('Case not found.');
        throw conflict(
          'CASE_ALREADY_RESOLVED',
          'This case was already resolved.',
        );
      }
      await tx.billingReconciliationCaseAction.create({
        data: {
          caseId,
          action: 'CLOSED',
          result: input.outcome,
          note: input.note,
          actorPlatformOperatorId: operator.id,
        },
      });
      await tx.platformAuditEvent.create({
        data: {
          action: PLATFORM_AUDIT_ACTIONS.billingCaseResolved,
          outcome: 'SUCCEEDED',
          actorPlatformOperatorId: operator.id,
          reasonCode: input.outcome,
          targetType: 'billing_case',
          targetId: caseId,
          requestReference: requestReference ?? null,
        },
      });
    });
    return this.detail(caseId);
  }
}
