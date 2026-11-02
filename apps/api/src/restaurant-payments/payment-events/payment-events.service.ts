import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import type { PaymentProvider } from '@mocha-house/integrations';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { CheckoutService } from '../../orders/application/checkout.service';
import { PAYMENT_PROVIDER } from '../../payment/payment-provider.token';
import { openReconciliationCase } from '../../payment/payment-charge';
import {
  PAYMENT_EVENT_TYPES,
  StripePaymentIntentProvider,
  type VerifiedPaymentEvent,
} from '../provider/stripe-payment-intent-provider';

// ESP-04 M3 (D6/D7) — Stripe payment events about intents on the
// restaurants' connected accounts (B1: their own endpoint and signing
// secret). An event is only a NUDGE: the payment's state is always read back
// from Stripe, on the account the payment was created on, and moved only by
// the same conditional transitions a customer's check uses; a paid payment's
// order is created from its saved checkout exactly once (the locked
// fulfilment path every retry and recovery takes). Nothing here charges,
// creates a payment, or trusts an event's body beyond finding the payment.
//
// Linking (never from metadata):
//   event `account`  -> OUR TenantPaymentAccount (unknown: IGNORED)
//                    -> its business
//   (business, intent id, account) -> that business's Stripe payment attempt
//   no such attempt: UNMATCHED — kept for reconciliation (ESP-04 M4), never
//   linked. An event that names no CENTERIVO payment and does not even claim
//   to be ours (a restaurant's own Stripe sales) is acknowledged and not
//   kept, so the table cannot grow from unrelated traffic.
//
// Crash safety (safeguard 2):
//   * an event is recorded once (unique per event id) BEFORE it is
//     processed, and it is acknowledged (2xx) ONLY once it is finally
//     handled: PROCESSED, IGNORED or UNMATCHED. Anything else answers 503,
//     so Stripe delivers it again;
//   * a recorded event that is not finished (RECEIVED after a crash, FAILED
//     after an error) is processed again by the next delivery — a known
//     event id never makes an unfinished event look handled, including a
//     concurrent duplicate delivery;
//   * processing is idempotent (reads, conditional updates, the locked
//     fulfilment), so a redelivery, a concurrent delivery or a re-drive can
//     never create a second order or move a payment twice;
//   * the optional re-drive (RESTAURANT_PAYMENT_EVENT_REDRIVE_ENABLED=1, OFF
//     by default) processes unfinished events again from what was stored
//     (account, intent, type), in small batches with backoff and a cap.
//     Whether or not it runs, an unfinished event is never acknowledged.
//   * the provider read is bounded (PAYMENT_EVENT_PROVIDER_TIMEOUT_MS).

export const PAYMENT_EVENT_PROVIDER_TIMEOUT_MS = 8_000;
export const REDRIVE_INTERVAL_MS = 60_000;
export const REDRIVE_GRACE_MS = 2 * 60_000;
export const REDRIVE_BATCH = 20;
export const REDRIVE_MAX_ATTEMPTS = 8;

const FINISHED: ReadonlySet<string> = new Set([
  'PROCESSED',
  'IGNORED',
  'UNMATCHED',
]);

type EventRow = Prisma.RestaurantPaymentProviderEventGetPayload<
  Record<string, never>
>;

export function paymentEventRedriveEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.RESTAURANT_PAYMENT_EVENT_REDRIVE_ENABLED === '1';
}

// Exponential backoff between re-drives of one event: 1, 2, 4 … 60 minutes.
export function redriveBackoffMs(attempts: number): number {
  return Math.min(60, 2 ** Math.max(0, attempts - 1)) * 60_000;
}

@Injectable()
export class PaymentEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentEventsService.name);
  private timer: NodeJS.Timeout | null = null;
  private redriving = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly checkout: CheckoutService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  // OFF by default: nothing is scheduled unless the deployment explicitly
  // sets RESTAURANT_PAYMENT_EVENT_REDRIVE_ENABLED=1, and only when Stripe
  // payments are configured.
  onModuleInit(): void {
    if (
      !paymentEventRedriveEnabled() ||
      !(this.provider instanceof StripePaymentIntentProvider)
    ) {
      return;
    }
    this.timer = setInterval(() => {
      this.redrive().catch((error: unknown) => {
        this.logger.error(
          `payment event re-drive failed (${
            error instanceof Error ? error.name : 'unknown error'
          })`,
        );
      });
    }, REDRIVE_INTERVAL_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // A verified delivery. True when the event is finally handled (the caller
  // answers 2xx); false when it must be delivered again (503).
  async handle(event: VerifiedPaymentEvent): Promise<boolean> {
    // Only payment-intent events belong to this endpoint; anything else it
    // is sent is acknowledged and never touches a stored event (an account
    // event recorded by the M1 endpoint stays that endpoint's).
    if (!PAYMENT_EVENT_TYPES.has(event.type)) return true;
    const key = {
      provider_externalEventId: {
        provider: event.provider,
        externalEventId: event.externalEventId,
      },
    };
    let stored = await this.prisma.restaurantPaymentProviderEvent.findUnique({
      where: key,
    });
    if (stored && FINISHED.has(stored.status)) return true;
    if (!stored) {
      // Not CENTERIVO's (no metadata claim and no payment of ours names the
      // intent): a restaurant's own Stripe traffic, acknowledged unrecorded.
      if (!event.claimsCenterivo && !(await this.namesOurPayment(event))) {
        return true;
      }
      try {
        stored = await this.prisma.restaurantPaymentProviderEvent.create({
          data: {
            provider: event.provider,
            externalEventId: event.externalEventId,
            type: event.type,
            livemode: event.livemode,
            externalAccountId: event.externalAccountId,
            externalObjectId: event.externalObjectId,
            payloadDigest: event.payloadDigest,
          },
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        // A concurrent delivery recorded it first. Acknowledged only if that
        // one has FINISHED it; otherwise this delivery processes it too
        // (idempotent), so a crash of the other can never strand it.
        stored = await this.prisma.restaurantPaymentProviderEvent.findUnique({
          where: key,
        });
        if (!stored) return false;
        if (FINISHED.has(stored.status)) return true;
      }
    }
    return this.process(stored);
  }

  // Unfinished payment events, processed again from what was stored. Bounded
  // (batch, backoff, cap); a re-drive already running in this process makes
  // this a no-op. Concurrent re-drives in other processes are harmless:
  // processing is idempotent.
  async redrive(now: Date = new Date()): Promise<number> {
    if (this.redriving) return 0;
    this.redriving = true;
    try {
      const due = await this.prisma.restaurantPaymentProviderEvent.findMany({
        where: {
          status: { in: ['RECEIVED', 'FAILED'] },
          type: { in: [...PAYMENT_EVENT_TYPES] },
          externalObjectId: { not: null },
          attempts: { lt: REDRIVE_MAX_ATTEMPTS },
          receivedAt: { lt: new Date(now.getTime() - REDRIVE_GRACE_MS) },
        },
        // Least recently tried first (never tried before anything), so the
        // events still backing off cannot crowd out those that are due.
        orderBy: [
          { lastAttemptAt: { sort: 'asc', nulls: 'first' } },
          { receivedAt: 'asc' },
        ],
        take: REDRIVE_BATCH * 5,
      });
      let processed = 0;
      for (const row of due) {
        if (processed >= REDRIVE_BATCH) break;
        if (
          row.lastAttemptAt !== null &&
          now.getTime() - row.lastAttemptAt.getTime() <
            redriveBackoffMs(row.attempts)
        ) {
          continue;
        }
        processed += 1;
        await this.process(row).catch(() => false);
      }
      return processed;
    } finally {
      this.redriving = false;
    }
  }

  // One processing attempt of a recorded event. Counted from the moment it
  // starts, so an interrupted attempt still backs off.
  private async process(row: EventRow): Promise<boolean> {
    await this.prisma.restaurantPaymentProviderEvent.updateMany({
      where: { id: row.id, status: { in: ['RECEIVED', 'FAILED'] } },
      data: { attempts: { increment: 1 }, lastAttemptAt: new Date() },
    });
    const settle = async (
      status: 'PROCESSED' | 'IGNORED' | 'UNMATCHED' | 'FAILED',
      outcome: string,
    ): Promise<boolean> => {
      // Never moves a finished event back (a concurrent delivery may have
      // finished it).
      await this.prisma.restaurantPaymentProviderEvent.updateMany({
        where: { id: row.id, status: { in: ['RECEIVED', 'FAILED'] } },
        data: {
          status,
          outcome,
          processedAt: status === 'FAILED' ? null : new Date(),
        },
      });
      if (status !== 'FAILED') return true;
      const now = await this.prisma.restaurantPaymentProviderEvent.findUnique({
        where: { id: row.id },
        select: { status: true },
      });
      return now !== null && FINISHED.has(now.status);
    };

    let matchedAttemptId: string | null = null;
    try {
      if (row.livemode) return await settle('IGNORED', 'LIVE_MODE_REFUSED');
      if (!(this.provider instanceof StripePaymentIntentProvider)) {
        // Payments are not configured here: nothing can be read. Delivered
        // again later (never acknowledged as handled).
        return await settle('FAILED', 'PAYMENTS_NOT_CONFIGURED');
      }
      if (!row.externalAccountId) {
        return await settle('IGNORED', 'NO_ACCOUNT');
      }
      if (!row.externalObjectId) {
        return await settle('IGNORED', 'NO_PAYMENT_INTENT');
      }
      // The business, from OUR stored account id only.
      const account = await this.prisma.tenantPaymentAccount.findUnique({
        where: { externalAccountId: row.externalAccountId },
        select: { tenantId: true, provider: true, livemode: true },
      });
      if (!account || account.provider !== 'stripe' || account.livemode) {
        return await settle('IGNORED', 'UNKNOWN_ACCOUNT');
      }
      // That business's payment for exactly this intent on exactly this
      // account. Never another business's, never from metadata.
      const attempt = await this.prisma.paymentAttempt.findFirst({
        where: {
          tenantId: account.tenantId,
          provider: 'stripe',
          providerReference: row.externalObjectId,
          providerAccountId: row.externalAccountId,
        },
        select: { id: true },
      });
      if (!attempt) {
        // Kept, with its account and intent, for reconciliation.
        return await settle('UNMATCHED', 'NO_MATCHING_PAYMENT');
      }
      matchedAttemptId = attempt.id;
      const result = await this.checkout.reconcileProviderPayment(
        account.tenantId,
        attempt.id,
        PAYMENT_EVENT_PROVIDER_TIMEOUT_MS,
      );
      if (result === 'settled') {
        return await settle('PROCESSED', 'PAYMENT_RECONCILED');
      }
      await this.makeVisible(attempt.id);
      return await settle('FAILED', 'PAYMENT_NOT_SETTLED');
    } catch (error) {
      if (matchedAttemptId) await this.makeVisible(matchedAttemptId);
      this.logger.warn(
        `payment event ${row.id}: not processed (${
          error instanceof Error ? error.name : 'unknown error'
        })`,
      );
      return settle('FAILED', 'PROCESSING_ERROR').catch(() => false);
    }
  }

  // A payment Stripe told us about that could not be settled yet (money may
  // have moved) is made visible to people with a reconciliation case, so it
  // never depends on the event being redelivered or re-driven. The case is
  // resolved by the payment's own outcome (fulfilled, or confirmed not
  // charged); an existing case is left as it is. Best effort.
  private async makeVisible(paymentAttemptId: string): Promise<void> {
    await openReconciliationCase(
      this.prisma,
      paymentAttemptId,
      'PROVIDER_EVENT_NOT_SETTLED',
      { outcome: 'unknown' },
    );
  }

  // Whether one of our Stripe payments names this event's intent (any
  // business: only used to decide whether the event is worth keeping).
  private async namesOurPayment(event: VerifiedPaymentEvent): Promise<boolean> {
    if (!event.externalObjectId) return false;
    const found = await this.prisma.paymentAttempt.findFirst({
      where: { provider: 'stripe', providerReference: event.externalObjectId },
      select: { id: true },
    });
    return found !== null;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'P2002'
  );
}
