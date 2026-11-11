import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PAYMENT_RECOVERY_CASE_RESOLVED,
  PAYMENT_RECOVERY_IN_PROGRESS,
  PAYMENT_RECOVERY_NOT_CONFIRMED,
  PAYMENT_RECOVERY_NOTHING_TO_RECOVER,
  PAYMENT_RECHECK_NOT_APPLICABLE,
  type PaymentCaseCategory,
  type PaymentCasePurchaseKind,
  type PaymentCaseStatus,
  type PaymentRecoveryResult,
  type PlatformPaymentCaseDetail,
  type PlatformPaymentCaseEvent,
  type PlatformPaymentCaseListResponse,
  type PlatformPaymentCaseRecoverResponse,
  type PlatformPaymentCaseRecheckResponse,
  type PlatformPaymentCaseSummary,
  type PlatformUnmatchedPaymentEventsResponse,
  type StripeRecheckResult,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { PLATFORM_AUDIT_ACTIONS } from '../../platform-auth/application/platform-operators.service';
import type { PlatformOperatorRow } from '../../platform-auth/infrastructure/platform-identity';
import {
  automaticRecoveryEnabled,
  MAX_AUTOMATIC_ATTEMPTS,
  nextAutomaticAttemptAt,
  PaymentRecoveryService,
  recoveryHistoryOf,
} from './payment-recovery.service';
import { RECOVERABLE_HELD_STATES } from '../../payment/payment-intent-recovery';
import type { PaymentCaseQuery } from './payment-case-query';

// ESP-03 PR 5 — restaurant payment reconciliation cases in the Platform
// Console, for CENTERIVO support. Cross-business by design (platform
// operators only, behind PlatformAuthGuard and the payments.reconciliation.*
// permissions): every read and write is keyed by the case, and everything
// reached from a case is reached through its own business (composite keys).
//
// Minimal data: payment and order references, amounts, states, fixed reason
// codes and the recovery history. Never card data, gift-card codes, the
// saved checkout, guest or customer contact details, provider error text or
// the restaurant staff member behind a staff action.

const LIST_LIMIT = 100;
// With a category filter (derived, not stored) at most this many cases are
// examined.
const CATEGORY_SCAN_LIMIT = 500;
const HISTORY_LIMIT = 200;
const NOTE_LIMIT = 200;

const HELD_STATES = new Set(['CHARGING', 'AWAITING_CONFIRMATION', 'UNKNOWN']);

// Event detail keys support may see (all written by the payment, fulfilment
// and recovery code as fixed codes or record ids).
const DETAIL_KEYS = new Set([
  'source',
  'reasonCode',
  'outcome',
  'resolution',
  'trigger',
  'failure',
  'retryable',
  'from',
  'to',
  'paymentAttemptId',
  'orderId',
  'giftCardPurchaseId',
]);

// ESP-04 M4a — at most this many unmatched Stripe events are listed.
const UNMATCHED_LIST_LIMIT = 100;

const CASE_SELECT = {
  id: true,
  tenantId: true,
  status: true,
  reasonCode: true,
  resolution: true,
  createdAt: true,
  updatedAt: true,
  resolvedAt: true,
  tenant: { select: { id: true, name: true } },
  paymentAttempt: {
    select: {
      id: true,
      provider: true,
      amount: true,
      currency: true,
      status: true,
      paymentState: true,
      fulfilmentStatus: true,
      providerReference: true,
      updatedAt: true,
      order: { select: { id: true, orderNumber: true } },
      checkoutSnapshot: { select: { id: true } },
      giftCardPurchase: { select: { id: true, giftCardId: true } },
    },
  },
  events: {
    where: {
      OR: [
        { action: { startsWith: 'RECOVERY_' } },
        // ESP-04 M4a — Stripe outcome recovery history.
        { action: { startsWith: 'STRIPE_RECHECK_' } },
        // ESP-04 M4b — abandoned payment cleanup history.
        { action: { startsWith: 'STRIPE_ABANDON_' } },
      ],
    },
    select: { action: true, detail: true, createdAt: true },
  },
} satisfies Prisma.PaymentReconciliationCaseSelect;

type CaseRow = Prisma.PaymentReconciliationCaseGetPayload<{
  select: typeof CASE_SELECT;
}>;

export function categoryOf(
  row: Pick<CaseRow, 'status' | 'resolution' | 'paymentAttempt' | 'events'>,
  now: Date = new Date(),
): PaymentCaseCategory {
  if (row.status === 'RESOLVED') {
    return row.resolution === 'FULFILLED' ? 'RECOVERED' : 'CLOSED';
  }
  const payment = row.paymentAttempt;
  const confirmed =
    payment.status === 'SUCCEEDED' && payment.paymentState === 'SUCCEEDED';
  if (!confirmed) {
    // Not definitively charged and not definitively refused: only the
    // provider's verified outcome can move it on.
    if (
      payment.status === 'PENDING' ||
      HELD_STATES.has(payment.paymentState ?? '')
    ) {
      // ESP-04 M4a — a Stripe payment the automatic Stripe recovery has set
      // aside (a failure a retry cannot fix, or its attempts used up) needs
      // people.
      if (payment.provider === 'stripe') {
        // ESP-04 M4b — and likewise for abandoned payment cleanup (a stale
        // authentication, an intent not provably unpaid).
        for (const prefix of ['STRIPE_RECHECK', 'STRIPE_ABANDON'] as const) {
          const stripe = recoveryHistoryOf(row.events, now, prefix);
          if (stripe.inProgressSince) return 'RECOVERY_IN_PROGRESS';
          if (
            (stripe.lastFailure !== null && !stripe.lastFailureRetryable) ||
            stripe.automaticAttempts >= MAX_AUTOMATIC_ATTEMPTS
          ) {
            return 'NEEDS_ATTENTION';
          }
        }
      }
      return 'AWAITING_PAYMENT_OUTCOME';
    }
    return 'NEEDS_ATTENTION';
  }
  if (recoveryHistoryOf(row.events, now).inProgressSince) {
    return 'RECOVERY_IN_PROGRESS';
  }
  return 'NEEDS_ATTENTION';
}

@Injectable()
export class PlatformPaymentCasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recovery: PaymentRecoveryService,
  ) {}

  async list(
    query: PaymentCaseQuery,
  ): Promise<PlatformPaymentCaseListResponse> {
    const where: Prisma.PaymentReconciliationCaseWhereInput = {
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: query.from } : {}),
              ...(query.to ? { lt: query.to } : {}),
            },
          }
        : {}),
    };
    const take = query.category ? CATEGORY_SCAN_LIMIT : LIST_LIMIT + 1;
    const rows = await this.prisma.paymentReconciliationCase.findMany({
      where,
      select: CASE_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    });
    const now = new Date();
    let summaries = rows.map((row) => this.summary(row, now));
    if (query.category) {
      summaries = summaries.filter((s) => s.category === query.category);
    }
    return {
      cases: summaries.slice(0, LIST_LIMIT),
      automaticRecoveryEnabled: automaticRecoveryEnabled(),
      truncated:
        summaries.length > LIST_LIMIT ||
        (query.category !== undefined && rows.length === CATEGORY_SCAN_LIMIT),
    };
  }

  async detail(caseId: string): Promise<PlatformPaymentCaseDetail> {
    const row = await this.findCase(caseId);
    const [events, notes] = await Promise.all([
      this.prisma.paymentReconciliationEvent.findMany({
        where: { caseId: row.id, tenantId: row.tenantId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: HISTORY_LIMIT,
        select: {
          id: true,
          action: true,
          actorKind: true,
          detail: true,
          createdAt: true,
        },
      }),
      this.prisma.paymentReconciliationNote.findMany({
        where: { caseId: row.id, tenantId: row.tenantId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: NOTE_LIMIT,
        select: {
          id: true,
          body: true,
          authorPlatformOperatorId: true,
          createdAt: true,
        },
      }),
    ]);
    const operatorIds = new Set(notes.map((n) => n.authorPlatformOperatorId));
    for (const event of events) {
      const id = operatorIdOf(event.detail);
      if (id) operatorIds.add(id);
    }
    const operators = operatorIds.size
      ? await this.prisma.platformOperator.findMany({
          where: { id: { in: [...operatorIds] } },
          select: { id: true, email: true },
        })
      : [];
    const emailOf = new Map(operators.map((o) => [o.id, o.email]));
    return {
      case: this.summary(row, new Date()),
      events: events.map((event): PlatformPaymentCaseEvent => {
        const detail = visibleDetail(event.detail);
        const operatorId = operatorIdOf(event.detail);
        if (operatorId) {
          detail.requestedBy = emailOf.get(operatorId) ?? 'platform support';
        }
        return {
          id: event.id,
          action: event.action,
          actor: event.actorKind === 'USER' ? 'RESTAURANT_STAFF' : 'SYSTEM',
          detail,
          createdAt: event.createdAt.toISOString(),
        };
      }),
      notes: notes.map((note) => ({
        id: note.id,
        body: note.body,
        authorEmail:
          emailOf.get(note.authorPlatformOperatorId) ?? 'unknown operator',
        createdAt: note.createdAt.toISOString(),
      })),
      automaticRecoveryEnabled: automaticRecoveryEnabled(),
    };
  }

  // A safe recovery attempt requested by support: the same path as the
  // automatic sweeper, so it can never charge, never act on an uncertain
  // payment and never create a second order. The written reason is kept as
  // a note and the request is in the platform audit: SUCCEEDED (with the
  // result as its reason code, RECOVERY_FAILED_<failure> for a failed
  // attempt) when it ran, DENIED (with the refusal code) when it was
  // refused. A resolved case is never acted on.
  async recover(
    caseId: string,
    reason: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformPaymentCaseRecoverResponse> {
    const row = await this.findCase(caseId);
    const refuse = async (code: string, message: string): Promise<never> => {
      await this.prisma.platformAuditEvent.create({
        data: {
          action: PLATFORM_AUDIT_ACTIONS.paymentCaseRecoveryRequested,
          outcome: 'DENIED',
          reasonCode: code,
          actorPlatformOperatorId: operator.id,
          targetType: 'payment_case',
          targetId: row.id,
          requestReference: requestReference ?? null,
        },
      });
      throw new ConflictException({ code, message });
    };
    if (row.status === 'RESOLVED') {
      return refuse(
        PAYMENT_RECOVERY_CASE_RESOLVED,
        'This case is already resolved. Nothing was done.',
      );
    }
    const outcome = await this.recovery.recoverOne(
      row.paymentAttemptId,
      row.tenantId,
      { trigger: 'platform_support', platformOperatorId: operator.id },
    );
    let result: PaymentRecoveryResult;
    let failure: string | null = null;
    switch (outcome.kind) {
      case 'recovered':
        result = 'RECOVERED';
        break;
      case 'already_fulfilled':
        result = 'ALREADY_FULFILLED';
        break;
      case 'failed':
        result = 'FAILED';
        failure = outcome.failure;
        break;
      case 'not_found':
        throw new NotFoundException('Payment case not found.');
      case 'not_confirmed':
        return refuse(
          PAYMENT_RECOVERY_NOT_CONFIRMED,
          'This payment is not confirmed as successful, so nothing can be recovered. It stays open until the payment outcome is verified.',
        );
      case 'nothing_to_recover':
        return refuse(
          PAYMENT_RECOVERY_NOTHING_TO_RECOVER,
          'There is no saved checkout or gift-card purchase to recover this payment from. It needs a manual investigation.',
        );
      case 'busy':
        return refuse(
          PAYMENT_RECOVERY_IN_PROGRESS,
          'A recovery of this payment is already running. Refresh in a moment.',
        );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.paymentReconciliationNote.create({
        data: {
          tenantId: row.tenantId,
          caseId: row.id,
          authorPlatformOperatorId: operator.id,
          body: `Recovery requested: ${reason}`.slice(0, 1000),
        },
      });
      await tx.platformAuditEvent.create({
        data: {
          action: PLATFORM_AUDIT_ACTIONS.paymentCaseRecoveryRequested,
          outcome: 'SUCCEEDED',
          reasonCode: failure ? `RECOVERY_FAILED_${failure}` : result,
          actorPlatformOperatorId: operator.id,
          targetType: 'payment_case',
          targetId: row.id,
          requestReference: requestReference ?? null,
        },
      });
    });
    return { result, failure, detail: await this.detail(row.id) };
  }

  async addNote(
    caseId: string,
    body: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformPaymentCaseDetail> {
    const row = await this.findCase(caseId);
    await this.prisma.$transaction(async (tx) => {
      await tx.paymentReconciliationNote.create({
        data: {
          tenantId: row.tenantId,
          caseId: row.id,
          authorPlatformOperatorId: operator.id,
          body,
        },
      });
      await tx.platformAuditEvent.create({
        data: {
          action: PLATFORM_AUDIT_ACTIONS.paymentCaseNoteAdded,
          outcome: 'SUCCEEDED',
          actorPlatformOperatorId: operator.id,
          targetType: 'payment_case',
          targetId: row.id,
          requestReference: requestReference ?? null,
        },
      });
    });
    return this.detail(row.id);
  }

  // ESP-04 M4a — "Recheck with Stripe": one Stripe outcome recovery of this
  // case's payment now, the same path as the automatic one (it never
  // charges, never creates a second intent, never replays outside the safe
  // window, and releases holds only on a proven cancellation with nothing
  // received). Audited like "Recover now": SUCCEEDED with the result (or
  // RECHECK_FAILED_<failure>) when it ran, DENIED with the refusal code
  // otherwise; the written reason is kept as a note. Does not count toward
  // the automatic attempts.
  async recheck(
    caseId: string,
    reason: string,
    operator: PlatformOperatorRow,
    requestReference: string | undefined,
  ): Promise<PlatformPaymentCaseRecheckResponse> {
    const row = await this.findCase(caseId);
    const audit = (
      outcome: 'SUCCEEDED' | 'DENIED',
      reasonCode: string,
      tx: Prisma.TransactionClient | PrismaService = this.prisma,
    ) =>
      tx.platformAuditEvent.create({
        data: {
          action: PLATFORM_AUDIT_ACTIONS.paymentCaseStripeRecheckRequested,
          outcome,
          reasonCode,
          actorPlatformOperatorId: operator.id,
          targetType: 'payment_case',
          targetId: row.id,
          requestReference: requestReference ?? null,
        },
      });
    const refuse = async (code: string, message: string): Promise<never> => {
      await audit('DENIED', code);
      throw new ConflictException({ code, message });
    };
    if (row.status === 'RESOLVED') {
      return refuse(
        PAYMENT_RECOVERY_CASE_RESOLVED,
        'This case is already resolved. Nothing was done.',
      );
    }
    const outcome = await this.recovery.recheckStripeOutcome(
      row.paymentAttemptId,
      row.tenantId,
      { trigger: 'platform_support', platformOperatorId: operator.id },
    );
    let result: StripeRecheckResult;
    let failure: string | null = null;
    switch (outcome.kind) {
      case 'settled':
        result = outcome.result;
        break;
      case 'failed':
        // Paid at Stripe and recorded; only its order is still pending.
        result =
          outcome.failure === 'STRIPE_FULFILMENT_PENDING'
            ? 'PAID'
            : outcome.retryable
              ? 'UNCHANGED'
              : 'NEEDS_ATTENTION';
        failure = outcome.failure;
        break;
      case 'not_found':
        throw new NotFoundException('Payment case not found.');
      case 'not_applicable':
        return refuse(
          PAYMENT_RECHECK_NOT_APPLICABLE,
          'Only a Stripe payment whose outcome is not final can be rechecked with Stripe. Nothing was done.',
        );
      case 'busy':
        return refuse(
          PAYMENT_RECOVERY_IN_PROGRESS,
          'A recovery of this payment is already running. Refresh in a moment.',
        );
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.paymentReconciliationNote.create({
        data: {
          tenantId: row.tenantId,
          caseId: row.id,
          authorPlatformOperatorId: operator.id,
          body: `Stripe recheck requested: ${reason}`.slice(0, 1000),
        },
      });
      await audit(
        'SUCCEEDED',
        failure ? `RECHECK_FAILED_${failure}` : result,
        tx,
      );
    });
    return { result, failure, detail: await this.detail(row.id) };
  }

  // ESP-04 M4a — the newest unmatched Stripe payment events (read-only):
  // ids, type and when, and the business the account belongs to (through
  // OUR stored account, never the event). No body, no personal data.
  async unmatchedEvents(): Promise<PlatformUnmatchedPaymentEventsResponse> {
    const rows = await this.prisma.restaurantPaymentProviderEvent.findMany({
      where: { provider: 'stripe', status: 'UNMATCHED' },
      orderBy: [{ receivedAt: 'desc' }, { id: 'desc' }],
      take: UNMATCHED_LIST_LIMIT + 1,
      select: {
        id: true,
        type: true,
        receivedAt: true,
        attempts: true,
        externalAccountId: true,
        externalObjectId: true,
      },
    });
    const accountIds = [
      ...new Set(
        rows.flatMap((r) => (r.externalAccountId ? [r.externalAccountId] : [])),
      ),
    ];
    const accounts = accountIds.length
      ? await this.prisma.tenantPaymentAccount.findMany({
          where: { externalAccountId: { in: accountIds } },
          select: {
            externalAccountId: true,
            tenant: { select: { id: true, name: true } },
          },
        })
      : [];
    const tenantOf = new Map(
      accounts.map((a) => [a.externalAccountId, a.tenant]),
    );
    return {
      events: rows.slice(0, UNMATCHED_LIST_LIMIT).map((r) => ({
        id: r.id,
        type: r.type,
        receivedAt: r.receivedAt.toISOString(),
        attempts: r.attempts,
        connectedAccountId: r.externalAccountId,
        paymentIntentId: r.externalObjectId,
        tenant: r.externalAccountId
          ? (tenantOf.get(r.externalAccountId) ?? null)
          : null,
      })),
      truncated: rows.length > UNMATCHED_LIST_LIMIT,
    };
  }

  // The Stripe outcome recovery view of a case's payment (null when it is
  // not a Stripe payment).
  private stripeRecheckOf(
    row: CaseRow,
    now: Date,
  ): PlatformPaymentCaseSummary['stripe'] {
    const payment = row.paymentAttempt;
    if (payment.provider !== 'stripe') return null;
    const history = recoveryHistoryOf(row.events, now, 'STRIPE_RECHECK');
    const open = row.status !== 'RESOLVED' && payment.status === 'PENDING';
    const held = (RECOVERABLE_HELD_STATES as readonly string[]).includes(
      payment.paymentState ?? '',
    );
    const next =
      open && held ? nextAutomaticAttemptAt(history, payment.updatedAt) : null;
    return {
      recheckable:
        open && (held || payment.paymentState === 'REQUIRES_CUSTOMER_ACTION'),
      automaticAttempts: history.automaticAttempts,
      lastFailure: history.lastFailure,
      lastFailureAt: history.lastFailureAt?.toISOString() ?? null,
      nextAutomaticAttemptAt: next
        ? new Date(Math.max(next.getTime(), now.getTime())).toISOString()
        : null,
    };
  }

  private async findCase(
    caseId: string,
  ): Promise<CaseRow & { paymentAttemptId: string }> {
    if (!isId(caseId)) throw new NotFoundException('Payment case not found.');
    const row = await this.prisma.paymentReconciliationCase.findUnique({
      where: { id: caseId },
      select: { ...CASE_SELECT, paymentAttemptId: true },
    });
    if (!row) throw new NotFoundException('Payment case not found.');
    return row;
  }

  private summary(row: CaseRow, now: Date): PlatformPaymentCaseSummary {
    const payment = row.paymentAttempt;
    const purchase = payment.giftCardPurchase;
    const purchaseKind: PaymentCasePurchaseKind = payment.order
      ? 'ORDER'
      : purchase
        ? 'GIFT_CARD'
        : payment.checkoutSnapshot
          ? 'ORDER'
          : 'UNKNOWN';
    const history = recoveryHistoryOf(row.events, now);
    const confirmed =
      payment.status === 'SUCCEEDED' && payment.paymentState === 'SUCCEEDED';
    const fulfilled = payment.order !== null || Boolean(purchase?.giftCardId);
    const recoverable =
      row.status !== 'RESOLVED' &&
      confirmed &&
      !fulfilled &&
      (payment.checkoutSnapshot !== null ||
        (purchase !== null && purchase.giftCardId === null));
    const next = recoverable
      ? nextAutomaticAttemptAt(history, payment.updatedAt)
      : null;
    return {
      id: row.id,
      tenant: { id: row.tenant.id, name: row.tenant.name },
      status: row.status as PaymentCaseStatus,
      category: categoryOf(row, now),
      reasonCode: row.reasonCode,
      resolution: row.resolution,
      purchaseKind,
      payment: {
        id: payment.id,
        amountMinorUnits: payment.amount,
        currency: payment.currency,
        status: payment.status,
        paymentState: payment.paymentState,
        fulfilmentStatus: payment.fulfilmentStatus,
        providerReference: payment.providerReference,
      },
      order: payment.order
        ? { id: payment.order.id, orderNumber: payment.order.orderNumber }
        : null,
      giftCardPurchase: purchase
        ? { id: purchase.id, issued: purchase.giftCardId !== null }
        : null,
      stripe: this.stripeRecheckOf(row, now),
      recovery: {
        recoverable,
        automaticAttempts: history.automaticAttempts,
        lastFailure: history.lastFailure,
        lastFailureAt: history.lastFailureAt?.toISOString() ?? null,
        nextAutomaticAttemptAt: next
          ? new Date(Math.max(next.getTime(), now.getTime())).toISOString()
          : null,
      },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      resolvedAt: row.resolvedAt?.toISOString() ?? null,
    };
  }
}

function visibleDetail(
  raw: unknown,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!DETAIL_KEYS.has(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 100);
    else if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = value;
    }
  }
  return out;
}

function operatorIdOf(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const value = (raw as Record<string, unknown>).platformOperatorId;
  return typeof value === 'string' && isId(value) ? value : null;
}

const ID_PATTERN = /^[0-9a-fA-F-]{36}$/;
function isId(value: string): boolean {
  return ID_PATTERN.test(value);
}
