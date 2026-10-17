import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { resolveBillingRecipient } from '@mocha-house/database';
import { PrismaService } from '../prisma/prisma.service';
import type { EmailSender } from '../notifications/email/email-sender';
import { EmailProviderRejection } from '../notifications/delivery-errors';
import {
  BILLING_EMAIL_DISPLAY_NAME,
  BILLING_EMAIL_SENDER,
} from './billing-email-sender';
import {
  BILLING_NOTICE_KINDS,
  parsePayload,
  renderBillingNotice,
  type BillingNoticeKind,
  type BillingNoticePayload,
} from './billing-templates';
import {
  BillingNotificationStore,
  MAX_ATTEMPTS,
  type BillingClaim,
} from './billing-notification-store';

// SC3c-3 — delivers CENTERIVO billing notices (queued by the API in the
// same transaction as the billing change). OFF unless
// BILLING_NOTIFICATIONS_ENABLED=1.
//
// For each leased notice, at delivery time:
//   1. stale (past expiresAt) or no longer true (the business paid, the
//      deadline moved, the case closed...) -> SKIPPED, nothing sent;
//   2. the recipient is resolved NOW (designated contact if eligible, else
//      the earliest eligible administrator — the shared rule); nobody
//      eligible -> SKIPPED and a BILLING_CONTACT_MISSING review case;
//   3. sent through the separate billing sender (BILLING_EMAIL_FROM).
// At most two attempts. A definite, retryable refusal or an ambiguous
// outcome (timeout) on the first attempt is retried once — an ambiguous one
// may then duplicate the email (flagged possibleDuplicate; never claimed
// exactly-once). After the last attempt fails: FAILED and a
// BILLING_NOTIFICATION_FAILED review case. No external paging.

export const BILLING_NOTIFICATIONS_ENV = 'BILLING_NOTIFICATIONS_ENABLED';
export const BILLING_CONTACT_MISSING_CASE = 'BILLING_CONTACT_MISSING';
// The DESIGNATED contact could not receive a notice (email not verified, or
// its verification expired; or no longer active / no billing.manage). Never
// silent: a case is opened even when the notice went to the fallback
// administrator, so an operator restores the designated contact.
export const BILLING_CONTACT_UNVERIFIED_CASE = 'BILLING_CONTACT_UNVERIFIED';
export const BILLING_NOTIFICATION_FAILED_CASE = 'BILLING_NOTIFICATION_FAILED';

const LEASE_MS = 60_000;
const SEND_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 30_000;

export function billingNotificationsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[BILLING_NOTIFICATIONS_ENV] === '1';
}

export type BillingDeliveryOutcome =
  'SENT' | 'SKIPPED' | 'RETRY' | 'FAILED' | 'LOST_CLAIM';

@Injectable()
export class BillingNotificationProcessor
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(BillingNotificationProcessor.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: BillingNotificationStore,
    @Inject(BILLING_EMAIL_SENDER) private readonly sender: EmailSender,
  ) {}

  onModuleInit(): void {
    if (!billingNotificationsEnabled()) return;
    this.timer = setInterval(() => {
      this.drain().catch((error: unknown) => {
        this.logger.error(
          `Billing notification run failed: ${error instanceof Error ? error.name : 'unknown'}`,
        );
      });
    }, POLL_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // Processes what is due now (bounded). One run at a time per process;
  // other instances are safe through the lease.
  async drain(limit = 50): Promise<BillingDeliveryOutcome[]> {
    if (!billingNotificationsEnabled() || this.running) return [];
    this.running = true;
    const outcomes: BillingDeliveryOutcome[] = [];
    try {
      for (const abandoned of await this.store.closeAbandoned(limit)) {
        await this.openCase(
          BILLING_NOTIFICATION_FAILED_CASE,
          abandoned.subscriptionId,
          `Billing notice ${abandoned.id} was abandoned mid-attempt after ${MAX_ATTEMPTS} attempts; it may or may not have been sent.`,
        );
      }
      for (let i = 0; i < limit; i++) {
        const claim = await this.store.claim(LEASE_MS);
        if (!claim) break;
        outcomes.push(await this.deliver(claim));
      }
    } finally {
      this.running = false;
    }
    return outcomes;
  }

  async deliver(claim: BillingClaim): Promise<BillingDeliveryOutcome> {
    const kind = claim.kind as BillingNoticeKind;
    if (!BILLING_NOTICE_KINDS.includes(kind)) {
      return this.close(claim, 'SKIPPED', 'UNKNOWN_KIND');
    }
    if (claim.dbNow >= claim.expiresAt) {
      return this.close(claim, 'SKIPPED', 'EXPIRED');
    }
    const payload = parsePayload(claim.payload);
    const subscription = await this.prisma.tenantSubscription.findUnique({
      where: { id: claim.subscriptionId },
      select: {
        subscriberTenantId: true,
        billingMode: true,
        status: true,
        pastDueAt: true,
        graceEndsAt: true,
        graceExceptionEndsAt: true,
        recoveryEndsAt: true,
        paymentSetupDueAt: true,
        paymentSetupExpiredAt: true,
        subscriberTenant: {
          select: { name: true, status: true, suspensionReason: true },
        },
      },
    });
    if (
      !subscription ||
      subscription.billingMode !== 'BILLED' ||
      !(await this.stillTrue(kind, payload, subscription, claim.dbNow))
    ) {
      return this.close(claim, 'SKIPPED', 'NO_LONGER_RELEVANT');
    }

    // The recipient, decided NOW (eligibility re-checked at delivery).
    const tenantId = subscription.subscriberTenantId;
    const resolution = await resolveBillingRecipient(
      this.prisma,
      tenantId,
      claim.dbNow,
    );
    const designatedIssue = resolution.designated?.ineligibleReason ?? null;
    if (designatedIssue !== null) {
      await this.openCase(
        BILLING_CONTACT_UNVERIFIED_CASE,
        claim.subscriptionId,
        `The designated billing contact could not receive a ${kind} notice (${designatedIssue}); ${
          resolution.recipient !== null
            ? 'it went to the fallback administrator instead.'
            : 'nobody else was eligible, so nothing was sent.'
        } They need to sign in again (or another contact designated).`,
      );
    }
    if (resolution.recipient === null) {
      await this.openCase(
        BILLING_CONTACT_MISSING_CASE,
        claim.subscriptionId,
        `No eligible billing recipient (active, billing.manage business-wide, recently verified email) for a ${kind} notice; nothing was sent.`,
      );
      return this.close(claim, 'SKIPPED', 'NO_ELIGIBLE_RECIPIENT');
    }

    const message = renderBillingNotice(
      kind,
      subscription.subscriberTenant.name,
      payload,
    );
    if (!(await this.store.markSendStarted(claim, LEASE_MS))) {
      return 'LOST_CLAIM';
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), SEND_TIMEOUT_MS);
    try {
      await this.sender.send({
        to: resolution.recipient.email,
        fromName: BILLING_EMAIL_DISPLAY_NAME,
        subject: message.subject,
        html: message.html,
        text: message.text,
        abortSignal: abort.signal,
      });
    } catch (error) {
      const definite = error instanceof EmailProviderRejection;
      const code = definite ? error.code : 'SEND_OUTCOME_UNKNOWN';
      const retryable = definite ? error.retryable : true;
      if (retryable && claim.attempt < MAX_ATTEMPTS) {
        return (await this.store.retryLater(claim, code, RETRY_DELAY_MS))
          ? 'RETRY'
          : 'LOST_CLAIM';
      }
      const closed = await this.close(claim, 'FAILED', code);
      if (closed === 'FAILED') {
        await this.openCase(
          BILLING_NOTIFICATION_FAILED_CASE,
          claim.subscriptionId,
          `A ${kind} billing notice could not be sent after ${claim.attempt} attempt(s) (${definite ? 'refused by the email provider' : 'outcome unknown; it may have been sent'}).`,
        );
      }
      // The error class only: provider messages can carry addresses.
      this.logger.warn(
        `Billing notice ${claim.id} attempt ${claim.attempt} failed: ${
          error instanceof Error ? error.name : 'unknown'
        }`,
      );
      return closed;
    } finally {
      clearTimeout(timer);
    }
    return this.close(claim, 'SENT', null);
  }

  // Whether what the notice says is STILL true now.
  private async stillTrue(
    kind: BillingNoticeKind,
    payload: BillingNoticePayload,
    subscription: {
      status: string;
      graceEndsAt: Date | null;
      graceExceptionEndsAt: Date | null;
      recoveryEndsAt: Date | null;
      paymentSetupDueAt: Date | null;
      paymentSetupExpiredAt: Date | null;
      subscriberTenant: { status: string; suspensionReason: string | null };
    },
    now: Date,
  ): Promise<boolean> {
    const same = (date: Date | null) =>
      date !== null &&
      payload.deadline !== null &&
      date.getTime() === new Date(payload.deadline).getTime();
    const billingSuspended =
      subscription.subscriberTenant.status === 'SUSPENDED' &&
      subscription.subscriberTenant.suspensionReason === 'BILLING';
    switch (kind) {
      case 'PAYMENT_FAILED':
        return subscription.status === 'PAST_DUE';
      case 'GRACE_ENDING':
        return (
          (subscription.status === 'PAST_DUE' &&
            same(subscription.graceEndsAt)) ||
          (subscription.status === 'UNPAID' &&
            same(subscription.graceExceptionEndsAt))
        );
      case 'BILLING_SUSPENDED':
        return billingSuspended;
      case 'ACCESS_RESTORED':
        return (
          !billingSuspended &&
          (!payload.temporary ||
            (subscription.status === 'UNPAID' &&
              subscription.graceExceptionEndsAt !== null &&
              subscription.graceExceptionEndsAt > now))
        );
      case 'TRIAL_EXPIRED':
        return subscription.status === 'TRIAL_EXPIRED';
      case 'TRIAL_RECOVERY_ENDING':
        return (
          subscription.status === 'TRIAL_EXPIRED' &&
          same(subscription.recoveryEndsAt)
        );
      case 'RESTART_CONFIRMED':
        return subscription.status === 'ACTIVE';
      // SC3e-4 — still the same open deadline; still paused for it.
      case 'PAYMENT_SETUP_ENDING':
        return (
          subscription.paymentSetupExpiredAt === null &&
          same(subscription.paymentSetupDueAt)
        );
      case 'PAYMENT_SETUP_EXPIRED':
        return billingSuspended && subscription.paymentSetupExpiredAt !== null;
      case 'RESTART_UNDER_REVIEW': {
        if (!payload.caseId) return false;
        const open = await this.prisma.billingReconciliationCase.findFirst({
          where: { id: payload.caseId, status: 'OPEN' },
          select: { id: true },
        });
        return open !== null;
      }
    }
  }

  private async close(
    claim: BillingClaim,
    status: 'SENT' | 'SKIPPED' | 'FAILED',
    code: string | null,
  ): Promise<BillingDeliveryOutcome> {
    return (await this.store.finish(claim, status, code))
      ? status
      : 'LOST_CLAIM';
  }

  // One OPEN case per subscription and kind (partial unique index): a
  // repeat is a no-op.
  private async openCase(
    kind: string,
    subscriptionId: string,
    detail: string,
  ): Promise<void> {
    await this.prisma.billingReconciliationCase.createMany({
      data: [{ kind, subscriptionId, detail: detail.slice(0, 500) }],
      skipDuplicates: true,
    });
  }
}
