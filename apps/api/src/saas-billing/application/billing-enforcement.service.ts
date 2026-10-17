import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import type { PlatformBillingEnforcementSweepResponse } from '@mocha-house/contracts';
import { PrismaService } from '../../prisma/prisma.service';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import type { PlatformOperatorRow } from '../../platform-auth/infrastructure/platform-identity';
import {
  BillingLifecycleError,
  BillingLifecycleService,
} from './billing-lifecycle.service';
import {
  billingEnforcementEnabled,
  billingEnforcementSweepIntervalMs,
} from './billing-enforcement.config';

const SWEEP_BATCH = 100;

// Refusals that mean "nothing to do any more" (another sweep, or a payment,
// got there first) — not failures.
const ALREADY_SETTLED = new Set([
  'NOT_PAST_DUE',
  'GRACE_NOT_OVER',
  'NOT_IN_RECOVERY',
  'RECOVERY_NOT_OVER',
  'CANCELED',
  'COMPLIMENTARY',
  'NO_GRACE_EXCEPTION',
  'GRACE_EXCEPTION_NOT_OVER',
]);

// SC3c-1 — the expiry sweep: when a grace period or an expired trial's
// recovery window is over, the change (GRACE_EXPIRED / RECOVERY_EXPIRED) is
// applied through the lifecycle, which suspends the business for billing in
// the same transaction. Idempotent: the lifecycle refuses an event that no
// longer applies, and every write is compare-and-set, so concurrent sweeps
// (several API instances) apply each change once. It runs on an interval
// only while BILLING_ENFORCEMENT_ENABLED=1; an operator can also run it.
@Injectable()
export class BillingEnforcementService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(BillingEnforcementService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: BillingLifecycleService,
  ) {}

  onModuleInit(): void {
    if (!billingEnforcementEnabled()) return;
    this.timer = setInterval(() => {
      this.sweep().catch((error: unknown) => {
        this.logger.error(
          `Billing enforcement sweep failed: ${
            error instanceof Error ? error.name : 'unknown'
          }`,
        );
      });
    }, billingEnforcementSweepIntervalMs());
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async sweep(now: Date = new Date()): Promise<{
    enabled: boolean;
    applied: number;
    failed: number;
  }> {
    if (!billingEnforcementEnabled()) {
      return { enabled: false, applied: 0, failed: 0 };
    }
    // One sweep at a time per process (another instance is safe anyway).
    if (this.running) return { enabled: true, applied: 0, failed: 0 };
    this.running = true;
    let applied = 0;
    let failed = 0;
    try {
      // SC3c-3 — reminders first (only while enforcement is on: a deadline
      // that changes nothing is never announced). Queued only while billing
      // notifications are enabled too.
      try {
        await this.lifecycle.queueReminders(now, SWEEP_BATCH);
      } catch (error) {
        this.logger.error(
          `Billing reminders failed: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
      // SC3e-4 — payment setup windows, expiries, recoveries, reminders.
      try {
        applied += (await this.lifecycle.paymentSetupSweep(now, SWEEP_BATCH))
          .expired;
      } catch (error) {
        failed++;
        this.logger.error(
          `Payment setup sweep failed: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      }
      const due = await this.lifecycle.dueForEnforcement(now, SWEEP_BATCH);
      for (const item of due) {
        try {
          await this.lifecycle.applyInternal(
            item.subscriptionId,
            { type: item.event, at: now },
            null,
          );
          applied++;
        } catch (error) {
          if (
            error instanceof BillingLifecycleError &&
            ALREADY_SETTLED.has(error.reason)
          ) {
            continue;
          }
          failed++;
          this.logger.error(
            `Billing enforcement for subscription ${item.subscriptionId} failed: ${
              error instanceof Error ? error.name : 'unknown'
            }`,
          );
        }
      }
    } finally {
      this.running = false;
    }
    return { enabled: true, applied, failed };
  }

  // An operator runs the sweep now (audited). Nothing happens while
  // enforcement is off.
  async sweepNow(
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformBillingEnforcementSweepResponse> {
    const result = await this.sweep();
    await this.prisma.platformAuditEvent.create({
      data: {
        action: PLATFORM_AUDIT_ACTIONS.billingEnforcementSwept,
        outcome: 'SUCCEEDED',
        actorPlatformOperatorId: operator.id,
        requestReference: requestReference ?? null,
      },
    });
    return result;
  }
}
