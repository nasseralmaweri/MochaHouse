import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { runSerializable } from '../../prisma/serializable-transaction';
import {
  SAAS_BILLING_PROVIDER,
  SaasBillingProviderError,
  type ProviderInvoice,
  type SaasBillingProvider,
} from '../provider/saas-billing-provider';
import {
  BillingLifecycleService,
  PLAN_CHANGE_UNCERTAIN_CASE,
} from './billing-lifecycle.service';
import { BillingPlanChangeService } from './billing-plan-change.service';

// SC3d-2 — plan change bookkeeping (owner decision D5). Runs whatever the
// billing enforcement and notification switches are: it never suspends,
// notifies or charges anyone NEW.
//   1. a preview older than its 10 minutes is EXPIRED;
//   2. a confirmed change whose submission was interrupted (REQUESTED, no
//      invoice) is re-sent as the SAME operation (original parameters and
//      idempotency key) only within 30 minutes of the confirmation, and only
//      when the provider already holds it or the charge re-checks EXACTLY as
//      confirmed (otherwise it ends; nothing is charged). Past 30 minutes it
//      is never re-sent: the provider is READ — the change closed when
//      nothing happened there, or reviewed when unclear;
//   3. a change waiting for payment is settled against the provider's live
//      view (applied once paid and verified; abandoned only once the provider
//      discarded it; reviewed after 48 hours without a resolution).
// Provider writes happen only in (2), for a change the business already
// confirmed, through the configured (test-mode) provider.

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const BATCH = 50;
// A confirmation still finishing in its own request is left alone.
const IN_FLIGHT_MS = 2 * 60 * 1000;
// Well inside the provider's 24-hour idempotency window, and close to the
// business's confirmation.
const REPLAY_WINDOW_MS = 30 * 60 * 1000;
const WAITING_REVIEW_MS = 48 * 60 * 60 * 1000;

export interface PlanChangeSweepResult {
  expiredPreviews: number;
  resubmitted: number;
  settled: number;
  reviewed: number;
}

@Injectable()
export class PlanChangeMaintenanceService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PlanChangeMaintenanceService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(SAAS_BILLING_PROVIDER)
    private readonly provider: SaasBillingProvider,
    private readonly lifecycle: BillingLifecycleService,
    private readonly planChanges: BillingPlanChangeService,
  ) {}

  onModuleInit(): void {
    if (process.env.PLAN_CHANGE_SWEEP_DISABLED === '1') return;
    this.timer = setInterval(() => {
      this.sweep().catch((error: unknown) => {
        this.logger.error(
          `Plan change sweep failed: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      });
    }, SWEEP_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(now: Date = new Date()): Promise<PlanChangeSweepResult> {
    const result: PlanChangeSweepResult = {
      expiredPreviews: 0,
      resubmitted: 0,
      settled: 0,
      reviewed: 0,
    };
    if (this.running) return result;
    this.running = true;
    try {
      // 1. Previews past their 10 minutes.
      result.expiredPreviews = (
        await this.prisma.billingPlanChange.updateMany({
          where: { status: 'PREVIEWED', previewExpiresAt: { lt: now } },
          data: { status: 'EXPIRED', finishedAt: now },
        })
      ).count;
      if (!this.provider.available) return result;

      // 2. Interrupted submissions.
      const requested = await this.prisma.billingPlanChange.findMany({
        where: {
          status: 'REQUESTED',
          externalInvoiceId: null,
          confirmedAt: { lt: new Date(now.getTime() - IN_FLIGHT_MS) },
        },
        orderBy: { confirmedAt: 'asc' },
        take: BATCH,
        select: { id: true, confirmedAt: true },
      });
      for (const change of requested) {
        try {
          if (
            now.getTime() - change.confirmedAt!.getTime() <
            REPLAY_WINDOW_MS
          ) {
            await this.planChanges.resubmitChecked(change.id);
            result.resubmitted++;
          } else if (await this.inspectAfterWindow(change.id)) {
            result.reviewed++;
          }
        } catch (error) {
          this.logError(change.id, error);
        }
      }

      // 3. Waiting for payment.
      const waiting = await this.prisma.billingPlanChange.findMany({
        where: { status: 'AWAITING_PAYMENT', externalInvoiceId: { not: null } },
        orderBy: { confirmedAt: 'asc' },
        take: BATCH,
        include: { subscription: { select: { externalSubscriptionId: true } } },
      });
      for (const change of waiting) {
        try {
          const externalSubscriptionId =
            change.subscription.externalSubscriptionId;
          if (externalSubscriptionId === null) continue;
          const snapshot = await this.provider.retrieveSubscription(
            externalSubscriptionId,
          );
          const invoice = await this.provider.retrieveInvoice(
            change.externalInvoiceId!,
          );
          const outcome = await runSerializable(this.prisma, async (tx) => {
            const settled = await this.lifecycle.settlePlanChange(
              tx,
              change.id,
              snapshot,
              invoice,
              {
                source: 'SYSTEM',
                billingProviderEventId: null,
                actorPlatformOperatorId: null,
              },
            );
            if (
              settled === 'WAITING' &&
              change.confirmedAt !== null &&
              now.getTime() - change.confirmedAt.getTime() > WAITING_REVIEW_MS
            ) {
              await this.lifecycle.markPlanChangeReview(
                tx,
                change.id,
                PLAN_CHANGE_UNCERTAIN_CASE,
                `Plan change ${change.id} has waited for payment over 48 hours without the provider applying or discarding it (invoice ${change.externalInvoiceId}, ${invoice?.status ?? 'unreadable'}). Nothing was charged or refunded here.`,
              );
              return 'REVIEW';
            }
            return settled;
          });
          if (outcome === 'REVIEW') result.reviewed++;
          else if (outcome !== 'WAITING') result.settled++;
        } catch (error) {
          this.logError(change.id, error);
        }
      }
    } finally {
      this.running = false;
    }
    return result;
  }

  // Past the provider's idempotency window the request is NEVER re-sent (it
  // could charge again). The provider is read instead. Returns true when
  // the change was reviewed.
  private async inspectAfterWindow(planChangeId: string): Promise<boolean> {
    const change = await this.prisma.billingPlanChange.findUniqueOrThrow({
      where: { id: planChangeId },
      include: {
        subscription: true,
        fromPlanPrice: { select: { externalPriceId: true } },
        toPlanPrice: { select: { externalPriceId: true } },
      },
    });
    const externalSubscriptionId = change.subscription.externalSubscriptionId;
    if (externalSubscriptionId === null) return false;
    const snapshot = await this.provider.retrieveSubscription(
      externalSubscriptionId,
    );
    const latest: ProviderInvoice | null =
      snapshot.latestInvoiceId !== null
        ? await this.provider.retrieveInvoice(snapshot.latestInvoiceId)
        : null;
    const item = snapshot.items?.length === 1 ? snapshot.items[0] : null;
    const stillOnOldPrice =
      item !== null &&
      item.externalPriceId === change.fromPlanPrice.externalPriceId;
    // Nothing happened at the provider: closed, nothing charged.
    if (
      stillOnOldPrice &&
      snapshot.hasPendingUpdate === false &&
      (latest === null || latest.billingReason !== 'subscription_update')
    ) {
      await this.prisma.billingPlanChange.updateMany({
        where: { id: change.id, status: 'REQUESTED' },
        data: {
          status: 'FAILED',
          failureCode: 'NOT_SUBMITTED',
          finishedAt: new Date(),
        },
      });
      return false;
    }
    // Anything else (a pending update, a moved price, an update invoice) may
    // be our request — never guessed: reviewed with the references.
    await runSerializable(this.prisma, (tx) =>
      this.lifecycle.markPlanChangeReview(
        tx,
        change.id,
        PLAN_CHANGE_UNCERTAIN_CASE,
        `Plan change ${change.id} was confirmed but its submission was never recorded, and the provider's state is unclear (latest invoice ${latest?.externalInvoiceId ?? 'none'}: ${latest?.billingReason ?? '-'}, ${latest?.status ?? '-'}; pending update ${snapshot.hasPendingUpdate === true ? 'yes' : 'no'}). Not re-sent; nothing applied here.`,
      ),
    );
    return true;
  }

  private logError(planChangeId: string, error: unknown): void {
    this.logger.error(
      `Plan change ${planChangeId} maintenance failed (${
        error instanceof SaasBillingProviderError
          ? 'PROVIDER_ERROR'
          : 'APPLY_ERROR'
      }): ${error instanceof Error ? error.name : 'unknown'}`,
    );
  }
}
