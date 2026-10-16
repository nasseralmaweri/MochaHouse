import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  PlatformReconciliationCase,
  PlatformReconciliationCaseListResponse,
  PlatformReconciliationCaseStatus,
  PlatformReconciliationRunResponse,
} from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { runSerializable } from '../../prisma/serializable-transaction';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import type { PlatformOperatorRow } from '../../platform-auth/infrastructure/platform-identity';
import { isUuid } from '../../platform-subscriptions/application/plan-input';
import type { ProviderSubscriptionStatus } from '../domain/provider-sync';
import {
  SAAS_BILLING_PROVIDER,
  type SaasBillingProvider,
} from '../provider/saas-billing-provider';
import { BillingLifecycleService } from './billing-lifecycle.service';

// SC3b (F6) — operator-run, REVIEW-ONLY billing reconciliation. It compares
// our billing records with the provider's and opens cases for a person to
// review. It never charges, refunds, credits or changes a subscription, and
// never "fixes" a mismatch: the only write besides cases is marking a
// Checkout EXPIRED when the provider says it expired (housekeeping).

// What our status should be for the provider's (null: no expectation).
const EXPECTED: Readonly<
  Record<ProviderSubscriptionStatus, readonly string[] | null>
> = {
  trialing: ['TRIALING'],
  active: ['ACTIVE', 'TRIALING'],
  past_due: ['PAST_DUE', 'UNPAID'],
  unpaid: ['UNPAID', 'PAST_DUE'],
  canceled: ['CANCELED', 'TRIAL_EXPIRED'],
  incomplete_expired: ['CANCELED', 'TRIAL_EXPIRED'],
  incomplete: null,
  paused: null,
};

// A FAILED event older than this is reviewed (newer ones are still being
// retried by the provider).
const FAILED_EVENT_AGE_MS = 60 * 60 * 1000;
const UNLINKED_CHECKOUT_AGE_MS = 60 * 60 * 1000;
const SWEEP_LIMIT = 500;

@Injectable()
export class BillingReconciliationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: BillingLifecycleService,
    @Inject(SAAS_BILLING_PROVIDER)
    private readonly provider: SaasBillingProvider,
  ) {}

  async run(
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
    now: Date = new Date(),
  ): Promise<PlatformReconciliationRunResponse> {
    const before = await this.prisma.billingReconciliationCase.count();
    let subscriptionsChecked = 0;
    let checkoutsExpired = 0;

    if (this.provider.available) {
      // 1. Our state against the provider's live subscription.
      const billed = await this.prisma.tenantSubscription.findMany({
        where: {
          billingMode: 'BILLED',
          billingProvider: this.provider.name,
          externalSubscriptionId: { not: null },
        },
        orderBy: { id: 'asc' },
        take: SWEEP_LIMIT,
      });
      for (const subscription of billed) {
        subscriptionsChecked++;
        let detail: string | null = null;
        let kind: string | null = null;
        try {
          const live = await this.provider.retrieveSubscription(
            subscription.externalSubscriptionId!,
          );
          const expected = EXPECTED[live.status];
          if (live.externalCustomerId !== subscription.externalCustomerId) {
            kind = 'CUSTOMER_MISMATCH';
            detail = 'The provider subscription belongs to another customer.';
          } else if (
            expected !== null &&
            !expected.includes(subscription.status)
          ) {
            kind = 'STATE_MISMATCH';
            detail = `Ours ${subscription.status}; provider ${live.status}.`;
          } else if (
            live.hasPaymentMethod !==
            (subscription.recurringPaymentAuthorizedAt !== null)
          ) {
            kind = 'PAYMENT_METHOD_MISMATCH';
            detail = `Ours ${
              subscription.recurringPaymentAuthorizedAt
                ? 'authorized'
                : 'not authorized'
            }; provider ${live.hasPaymentMethod ? 'has' : 'has no'} payment method.`;
          } else if (
            live.cancelAtPeriodEnd !== subscription.cancelAtPeriodEnd
          ) {
            kind = 'CANCELLATION_MISMATCH';
            detail = `Ours cancel-at-period-end ${subscription.cancelAtPeriodEnd}; provider ${live.cancelAtPeriodEnd}.`;
          }
        } catch {
          kind = 'PROVIDER_UNREADABLE';
          detail = 'The provider subscription could not be read.';
        }
        if (kind !== null) {
          await this.open(kind, subscription.id, null, detail);
        }
      }

      // 2. Checkouts: expired ones are closed; completed ones never linked
      //    are reviewed.
      const openCheckouts = await this.prisma.billingCheckoutSession.findMany({
        where: { status: 'OPEN', externalSessionId: { not: null } },
        take: SWEEP_LIMIT,
      });
      for (const checkout of openCheckouts) {
        try {
          const session = await this.provider.retrieveCheckoutSession(
            checkout.externalSessionId!,
          );
          if (session.status === 'expired') {
            const { count } =
              await this.prisma.billingCheckoutSession.updateMany({
                where: { id: checkout.id, status: 'OPEN' },
                data: { status: 'EXPIRED' },
              });
            checkoutsExpired += count;
          } else if (
            session.status === 'complete' &&
            now.getTime() - checkout.createdAt.getTime() >
              UNLINKED_CHECKOUT_AGE_MS
          ) {
            await this.open(
              'CHECKOUT_NOT_LINKED',
              checkout.subscriptionId,
              null,
              'Checkout completed at the provider but was never linked.',
            );
          }
        } catch {
          await this.open(
            'PROVIDER_UNREADABLE',
            checkout.subscriptionId,
            null,
            'A Checkout session could not be read.',
          );
        }
      }
    }

    // 3. Events that could not be applied (and are no longer being retried).
    const failed = await this.prisma.billingProviderEvent.findMany({
      where: {
        status: 'FAILED',
        receivedAt: { lt: new Date(now.getTime() - FAILED_EVENT_AGE_MS) },
      },
      take: SWEEP_LIMIT,
      select: { id: true, subscriptionId: true, outcome: true, type: true },
    });
    for (const event of failed) {
      await this.open(
        'EVENT_NOT_APPLIED',
        null,
        event.id,
        `${event.type}: ${event.outcome ?? 'unknown'}`.slice(0, 500),
      );
    }

    await this.prisma.platformAuditEvent.create({
      data: {
        action: PLATFORM_AUDIT_ACTIONS.billingReconciled,
        outcome: 'SUCCEEDED',
        actorPlatformOperatorId: operator.id,
        requestReference: requestReference ?? null,
      },
    });
    const after = await this.prisma.billingReconciliationCase.count();
    return {
      subscriptionsChecked,
      casesOpened: after - before,
      checkoutsExpired,
    };
  }

  private async open(
    kind: string,
    subscriptionId: string | null,
    billingProviderEventId: string | null,
    detail: string | null,
  ): Promise<void> {
    await runSerializable(this.prisma, (tx) =>
      this.lifecycle.openCase(
        tx,
        kind,
        subscriptionId,
        billingProviderEventId,
        detail,
      ),
    );
  }

  async list(status: unknown): Promise<PlatformReconciliationCaseListResponse> {
    const wanted: PlatformReconciliationCaseStatus =
      status === 'RESOLVED' ? 'RESOLVED' : 'OPEN';
    const rows = await this.prisma.billingReconciliationCase.findMany({
      where: { status: wanted },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 200,
      include: {
        subscription: {
          select: { subscriberTenant: { select: { id: true, name: true } } },
        },
        billingProviderEvent: {
          select: {
            subscription: {
              select: {
                subscriberTenant: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });
    return {
      cases: rows.map((row): PlatformReconciliationCase => {
        const tenant =
          row.subscription?.subscriberTenant ??
          row.billingProviderEvent?.subscription?.subscriberTenant ??
          null;
        return {
          id: row.id,
          kind: row.kind,
          tenantId: tenant?.id ?? null,
          businessName: tenant?.name ?? null,
          detail: row.detail,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          resolvedAt: row.resolvedAt?.toISOString() ?? null,
        };
      }),
    };
  }

  // Marks a case reviewed. It changes nothing else.
  async resolve(
    caseId: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<void> {
    if (!isUuid(caseId)) throw new NotFoundException('Case not found.');
    await runSerializable(this.prisma, async (tx) => {
      const { count } = await tx.billingReconciliationCase.updateMany({
        where: { id: caseId, status: 'OPEN' },
        data: {
          status: 'RESOLVED',
          resolvedAt: new Date(),
          resolvedByPlatformOperatorId: operator.id,
        },
      });
      if (count !== 1) {
        const exists = await tx.billingReconciliationCase.findUnique({
          where: { id: caseId },
          select: { id: true },
        });
        if (!exists) throw new NotFoundException('Case not found.');
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          code: 'CASE_ALREADY_RESOLVED',
          message: 'This case was already resolved.',
        });
      }
      await tx.platformAuditEvent.create({
        data: {
          action: PLATFORM_AUDIT_ACTIONS.billingCaseResolved,
          outcome: 'SUCCEEDED',
          actorPlatformOperatorId: operator.id,
          requestReference: requestReference ?? null,
        },
      });
    });
  }
}
