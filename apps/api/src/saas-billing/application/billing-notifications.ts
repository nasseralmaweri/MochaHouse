import type { Prisma } from '@mocha-house/database';
import { billingEnforcementEnabled } from './billing-enforcement.config';

// SC3c-3 — CENTERIVO billing notices to a business (platform billing, NOT
// the restaurant's own customer notifications). They are only QUEUED here,
// in the same transaction as the billing change they describe; the worker
// delivers them (apps/worker billing-notifications), choosing the recipient
// at delivery time.
//
// OFF unless BILLING_NOTIFICATIONS_ENABLED=1: while off nothing is queued.
// Each notice is deduplicated DURABLY by a key tied to the actual billing
// event or unpaid episode (never just a status name), so a redelivered
// provider event, a retried transaction or a second sweep never queues it
// twice. The payload holds no personal data and no payment link.

export const BILLING_NOTIFICATIONS_ENV = 'BILLING_NOTIFICATIONS_ENABLED';

export function billingNotificationsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[BILLING_NOTIFICATIONS_ENV] === '1';
}

export type BillingNoticeKind =
  | 'PAYMENT_FAILED'
  | 'GRACE_ENDING'
  | 'BILLING_SUSPENDED'
  | 'ACCESS_RESTORED'
  | 'TRIAL_EXPIRED'
  | 'TRIAL_RECOVERY_ENDING'
  | 'RESTART_CONFIRMED'
  | 'RESTART_UNDER_REVIEW'
  // SC3e-4 — a payment setup deadline is near; it passed.
  | 'PAYMENT_SETUP_ENDING'
  | 'PAYMENT_SETUP_EXPIRED';

export interface BillingNoticePayload {
  // The deadline the notice is about (grace / exception / recovery end).
  deadline: string | null;
  // Whether billing enforcement was on when queued: the email never
  // threatens a suspension that would not happen.
  enforced: boolean;
  // ACCESS_RESTORED by an operator's grace exception: temporary, not paid.
  temporary?: boolean;
  // RESTART_UNDER_REVIEW: the review case (re-checked at delivery).
  caseId?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
// A notice nobody could deliver within this long is stale.
const DEFAULT_TTL_MS = 3 * DAY_MS;

export async function enqueueBillingNotice(
  tx: Prisma.TransactionClient,
  notice: {
    subscriptionId: string;
    kind: BillingNoticeKind;
    // The event or episode the notice is about (part of the dedupe key).
    subject: string;
    deadline?: Date | null;
    temporary?: boolean;
    caseId?: string;
    now?: Date;
  },
): Promise<void> {
  if (!billingNotificationsEnabled()) return;
  const now = notice.now ?? new Date();
  const deadline = notice.deadline ?? null;
  // A reminder is pointless after its deadline; anything else after the TTL.
  const ttlEnd = new Date(now.getTime() + DEFAULT_TTL_MS);
  const expiresAt =
    deadline !== null && deadline < ttlEnd && deadline > now
      ? deadline
      : ttlEnd;
  const payload: BillingNoticePayload = {
    deadline: deadline?.toISOString() ?? null,
    enforced: billingEnforcementEnabled(),
    ...(notice.temporary ? { temporary: true } : {}),
    ...(notice.caseId ? { caseId: notice.caseId } : {}),
  };
  // Idempotent: the unique dedupe key makes a repeat a no-op (no error, so
  // the surrounding serializable transaction is unaffected).
  await tx.billingNotification.createMany({
    data: [
      {
        subscriptionId: notice.subscriptionId,
        kind: notice.kind,
        dedupeKey:
          `${notice.kind}:${notice.subscriptionId}:${notice.subject}`.slice(
            0,
            255,
          ),
        payload: payload as unknown as Prisma.InputJsonValue,
        expiresAt,
      },
    ],
    skipDuplicates: true,
  });
}
