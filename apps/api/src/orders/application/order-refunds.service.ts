import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ORDER_REFUND_NOTE_MAX_LENGTH,
  ORDER_REFUND_REASON_CODES,
  ORDER_REFUND_REASON_LABELS,
  type OrderRefundActionResponse,
  type OrderRefundBalances,
  type OrderRefundObligationStatus,
  type OrderRefundObligationView,
  type OrderRefundObligationsResponse,
  type OrderRefundReasonCode,
  type OrderRefundStatus,
  type OrderRefundView,
  type OrderRefundsResponse,
  type OrderStatus,
} from '@mocha-house/contracts';
import type {
  PaymentAccountContext,
  PaymentProvider,
} from '@mocha-house/integrations';
import type { Prisma, TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { PAYMENT_PROVIDER } from '../../payment/payment-provider.token';
import { paymentAccountForAttempt } from '../../payment/payment-intent';
import { withSessionLock } from '../../payment/session-lock';
import { syncRefundObligation } from './refund-obligation-sync';
import {
  notCreatedEvidenceFor,
  obligationStanding,
  refundIdempotencyKey,
  summarizeRefunds,
  transitionFor,
  type PaymentRefundStatus,
  type RefundRow,
} from '../../payment/payment-refunds';
import {
  StripePaymentIntentProvider,
  type RefundObservation,
  refundRequestRefusedLocally,
  type StripeRefundReason,
} from '../../restaurant-payments/provider/stripe-payment-intent-provider';

// ESP-04 M5b — refund execution: staff refunds of an order's ORIGINAL Stripe
// card payment, on the restaurant's own connected account, through the M5a
// foundation (PaymentRefund and its database guards, the refund rules, the
// Stripe adapter). OFF unless RESTAURANT_REFUNDS_ENABLED=1, and then only
// with Stripe payments configured and the business on the test-mode
// allowlist.
//
// One refund, step by step:
//   1. Authorise: `orders.refund` at the order's location (a denial is
//      audited); the order must be this business's, at that location.
//   2. Request identity: the page's requestId (one per submission). A repeat
//      returns the operation it created; the same id with anything else is a
//      conflict. Never a second refund for one request.
//   3. Locally: a COMPLETED order, or a REJECTED / CANCELLED one with money
//      still owed; a confirmed Stripe payment; nothing waiting for Stripe's
//      answer; no returned refund unreviewed; within what is left.
//   4. Stripe, before anything is recorded: the intent (test mode, amount,
//      currency, amount received, not disputed) and EVERY refund of it must
//      match our records — a refund made in the Dashboard that is not
//      recorded here fails closed (its ingestion is M5c).
//   5. Record the operation REQUESTED (its own idempotency key), in a short
//      transaction under the payment's lock (the database re-checks
//      capacity); the obligation, if any, becomes PROCESSING.
//   6. Under a per-refund session lock (no transaction open across the
//      network): mark it sent, ask Stripe, then ALWAYS read the refund back.
//      Only the read-back moves it (PENDING / SUCCEEDED / FAILED / CANCELED);
//      anything uncertain is UNKNOWN, its amount still reserved.
//   7. Settle the obligation once verified refunds cover it (no waiting
//      period); a failed attempt leaves it owed.
//
// Recheck (on demand; the automatic sweeper is M5c) of an unanswered refund:
// its Stripe id if known; else, within the replay window, the SAME request
// with the SAME key (never a fresh key); past it, the payment's complete
// refund history — "never created" only with M5a's evidence, otherwise it
// stays UNKNOWN.

const NOT_FOUND = 'Order not found for this location.';
const NOT_AVAILABLE = 'Card refunds are not available.';
const UNIQUE_VIOLATION = 'P2002';
// Stripe keeps idempotency keys for at least 24 hours; a request is replayed
// with its key only well inside that (the same margin as payment recovery).
export const REFUND_REPLAY_WINDOW_MS = 20 * 60 * 60 * 1000;
// Every Stripe call is bounded (the SDK has its own timeout and retries).
export const REFUND_STRIPE_TIMEOUT_MS = 25_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const OUR_ID = /^[A-Za-z0-9-]{1,100}$/;
// The same plain-text rule as order closure notes.
// ESP-04 M5d — how far back a reconciliation flag counts as current.
const ATTENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const NOTE_FORBIDDEN = new RegExp(
  '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F' + '​-‏ -‮⁠-⁩﻿]',
);

export function restaurantRefundsEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.RESTAURANT_REFUNDS_ENABLED === '1';
}

export interface RefundActor {
  id: string;
  tenantId: string;
}

type RefundRecord = Prisma.PaymentRefundGetPayload<{
  include: { requestedBy: { select: { id: true; displayName: true } } };
}>;

interface LoadedOrder {
  id: string;
  status: string;
  currency: string;
  orderNumber: string;
  locationId: string;
  paymentAttemptId: string;
  attempt: {
    id: string;
    tenantId: string;
    provider: string;
    status: string;
    paymentState: string | null;
    providerReference: string | null;
    providerAccountId: string | null;
    amount: number;
    currency: string;
    reconciliationRequired: boolean;
  };
  obligation: { id: string; amountMinorUnits: number; status: string } | null;
}

@Injectable()
export class OrderRefundsService {
  private readonly logger = new Logger(OrderRefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  // --- reads (orders.view) ----------------------------------------------------

  async listForOrder(
    orderId: string,
    locationId: unknown,
    actor: RefundActor,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<OrderRefundsResponse> {
    const location = this.requireLocation(locationId);
    authorization.assertCanActOnLocation('orders.view', location);
    this.assertSameBusiness(actor, tenant);
    const order = await this.loadOrder(orderId, location, tenant.tenantId);
    const rows = await this.refundsOf(tenant.tenantId, order.paymentAttemptId);
    const attention = await this.attentionOf(
      tenant.tenantId,
      order.paymentAttemptId,
      rows.map((r) => r.id),
    );
    return {
      ...attention,
      orderId: order.id,
      orderStatus: order.status as OrderStatus,
      currency: order.currency,
      refundsEnabled: this.executionAvailableFor(tenant.tenantId),
      balances: refundablePayment(order) ? balancesOf(order, rows) : null,
      obligation: obligationViewOf(order, rows),
      // Internal notes only for staff who may refund here.
      refunds: rows
        .map(viewOf)
        .map((r) =>
          authorization.canActOnLocation('orders.refund', location)
            ? r
            : { ...r, note: null, lateFailureReviewNote: null },
        ),
    };
  }

  async listObligations(
    locationId: unknown,
    actor: RefundActor,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<OrderRefundObligationsResponse> {
    const location = this.requireLocation(locationId);
    authorization.assertCanActOnLocation('orders.view', location);
    this.assertSameBusiness(actor, tenant);
    const obligations = await this.prisma.orderRefundObligation.findMany({
      // Not yet settled, or settled but with a refund whose money came back
      // (owed again): never only the newest ones.
      where: {
        tenantId: tenant.tenantId,
        order: { locationId: location },
        OR: [
          { status: { not: 'REFUNDED' } },
          {
            paymentAttempt: {
              refunds: { some: { status: 'FAILED_AFTER_SUCCESS' } },
            },
          },
        ],
      },
      select: {
        amountMinorUnits: true,
        status: true,
        paymentAttemptId: true,
        order: {
          select: { id: true, orderNumber: true, status: true, currency: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const refunds = await this.prisma.paymentRefund.findMany({
      where: {
        tenantId: tenant.tenantId,
        paymentAttemptId: { in: obligations.map((o) => o.paymentAttemptId) },
      },
      select: {
        paymentAttemptId: true,
        status: true,
        amountMinorUnits: true,
        origin: true,
        succeededAt: true,
        lateFailureReviewedAt: true,
      },
    });
    const items = obligations.flatMap((o) => {
      const standing = obligationStanding(
        o.amountMinorUnits,
        refunds
          .filter((r) => r.paymentAttemptId === o.paymentAttemptId)
          .map(rowOf),
        o.status,
      );
      if (standing.outstandingMinorUnits === 0 && !standing.needsAttention) {
        if (o.status === 'REFUNDED' || standing.inProgressMinorUnits === 0) {
          return [];
        }
      }
      return [
        {
          orderId: o.order.id,
          orderNumber: o.order.orderNumber,
          orderStatus: o.order.status,
          currency: o.order.currency,
          obligation: obligationView(o.amountMinorUnits, o.status, standing),
        },
      ];
    });
    return { obligations: items };
  }

  // --- a refund (orders.refund) --------------------------------------------------

  async request(
    orderId: string,
    body: unknown,
    actor: RefundActor,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<OrderRefundActionResponse> {
    const input = (body ?? {}) as Record<string, unknown>;
    // Off (404) before anything else, for everyone.
    const provider = this.stripeFor(tenant.tenantId);
    const location = this.requireLocation(input.locationId);
    await this.authorizeRefund(
      location,
      orderId,
      'request',
      actor,
      authorization,
      tenant,
    );
    const request = validateRequest(input);
    const fingerprint = fingerprintOf({
      tenantId: tenant.tenantId,
      orderId,
      locationId: location,
      actorId: actor.id,
      ...request,
    });

    // 2. A request already made: its operation, never a second one.
    const replay = await this.replayed(
      tenant.tenantId,
      request.requestId,
      fingerprint,
    );
    if (replay) return this.actionResponse(replay, true, location, tenant);

    // 3. Locally.
    const order = await this.loadOrder(orderId, location, tenant.tenantId);
    const attempt = order.attempt;
    if (order.status === 'REJECTED' || order.status === 'CANCELLED') {
      if (!order.obligation) {
        throw new ConflictException(
          'Nothing is owed on this order’s card payment.',
        );
      }
    } else if (order.status !== 'COMPLETED') {
      throw new ConflictException(
        'Only a completed order is refunded. An order in progress is cancelled instead.',
      );
    }
    if (!refundablePayment(order)) {
      throw new ConflictException(
        'This order has no confirmed card payment to refund.',
      );
    }
    if (attempt.reconciliationRequired) {
      throw new ConflictException(
        'This order’s payment needs reconciliation first. Contact support.',
      );
    }
    if (request.currency !== attempt.currency.toUpperCase()) {
      throw new BadRequestException(
        'The currency must be the payment’s own currency.',
      );
    }
    const rows = await this.refundsOf(tenant.tenantId, attempt.id);
    assertNoUnresolved(rows);
    const summary = summarizeRefunds(attempt.amount, rows.map(rowOf));
    // The balance the staff member saw: if refunds were made since (another
    // staff member, or the same refund resubmitted as a new request), this
    // one was decided on stale figures and is refused.
    assertExpectedReserved(summary.reservedMinorUnits, request);
    if (summary.lateFailureNeedsReview) {
      throw new ConflictException(
        'A refund of this payment came back and must be reviewed before another is made.',
      );
    }
    const limit = order.obligation
      ? Math.min(
          summary.refundableMinorUnits,
          obligationStanding(
            order.obligation.amountMinorUnits,
            rows.map(rowOf),
            order.obligation.status,
          ).outstandingMinorUnits,
        )
      : summary.refundableMinorUnits;
    if (request.amountMinorUnits > limit) {
      throw new ConflictException(
        `The refund is more than is left to refund (${limit} available).`,
      );
    }
    const account = await this.accountOf(attempt);

    // 4. Stripe agrees with our records, before anything is recorded.
    await this.verifyWithStripe(provider, attempt, account, rows);

    // 5. Record the operation, before Stripe is asked for it.
    const refundId = randomUUID();
    let created: RefundRecord;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT 1 FROM "PaymentAttempt"
           WHERE id = ${attempt.id} AND "tenantId" = ${tenant.tenantId}
           FOR UPDATE`;
        // Re-checked under the payment's lock: a concurrent request may
        // have just created one.
        const latest = await tx.paymentRefund.findMany({
          where: { tenantId: tenant.tenantId, paymentAttemptId: attempt.id },
          select: {
            status: true,
            amountMinorUnits: true,
            origin: true,
            succeededAt: true,
            lateFailureReviewedAt: true,
          },
        });
        assertNoUnresolved(latest);
        assertExpectedReserved(
          summarizeRefunds(attempt.amount, latest.map(rowOf))
            .reservedMinorUnits,
          request,
        );
        const refund = await tx.paymentRefund.create({
          data: {
            id: refundId,
            tenantId: tenant.tenantId,
            orderId: order.id,
            paymentAttemptId: attempt.id,
            provider: 'stripe',
            providerAccountId: attempt.providerAccountId!,
            origin: 'CENTERIVO',
            amountMinorUnits: request.amountMinorUnits,
            currency: request.currency,
            reasonCode: request.reasonCode,
            note: request.note,
            requestedByInternalUserId: actor.id,
            idempotencyKey: refundIdempotencyKey(refundId),
            status: 'REQUESTED',
            clientRequestId: request.requestId,
            requestFingerprint: fingerprint,
          },
          include: {
            requestedBy: { select: { id: true, displayName: true } },
          },
        });
        if (order.obligation) {
          await tx.orderRefundObligation.updateMany({
            where: {
              id: order.obligation.id,
              tenantId: tenant.tenantId,
              status: { in: ['DUE', 'FAILED'] },
            },
            data: { status: 'PROCESSING' },
          });
        }
        await this.audit.recordOrderRefundAction(tx, {
          actorInternalUserId: actor.id,
          action: 'order.refund_requested',
          orderId: order.id,
          refundId,
          amountMinorUnits: request.amountMinorUnits,
          currency: request.currency,
          reasonCode: request.reasonCode,
          status: 'REQUESTED',
          detail: { hasNote: request.note !== null },
        });
        return refund;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        // The same request, a moment earlier.
        const raced = await this.replayed(
          tenant.tenantId,
          request.requestId,
          fingerprint,
        );
        if (raced) return this.actionResponse(raced, true, location, tenant);
      }
      throw refusalFrom(error);
    }

    // 6. Ask Stripe, under this refund's lock, and read it back.
    const sent = await withSessionLock(lockKey(tenant.tenantId, refundId), () =>
      this.send(provider, created, attempt, account, actor),
    );
    const current = sent ?? (await this.reload(tenant.tenantId, refundId));
    return this.actionResponse(current, false, location, tenant);
  }

  // Asks Stripe for ONE recorded operation and records what the read-back
  // says. Never called while a database transaction is open.
  private async send(
    provider: StripePaymentIntentProvider,
    refund: RefundRecord,
    attempt: LoadedOrder['attempt'],
    account: PaymentAccountContext,
    actor: RefundActor,
  ): Promise<RefundRecord> {
    const params = createParams(refund, attempt, account);
    // A request the adapter would refuse without sending anything (it can
    // only be a defect here): never sent, provably not created — recorded
    // as such, so the payment is not blocked by a refund that never left.
    if (refundRequestRefusedLocally(params)) {
      this.logger.error(`refund ${refund.id}: refused before sending`);
      return this.recordOutcome(
        refund,
        { kind: 'not_created', evidence: 'NEVER_SENT' },
        actor,
      );
    }
    // Still REQUESTED and never sent (a recheck may have closed it): only
    // then is it sent, and the sending is recorded FIRST.
    const marked = await this.prisma.paymentRefund.updateMany({
      where: {
        id: refund.id,
        tenantId: refund.tenantId,
        status: 'REQUESTED',
        firstSentAt: null,
      },
      data: { firstSentAt: new Date() },
    });
    if (marked.count !== 1) return this.reload(refund.tenantId, refund.id);
    const outcome = await bounded(provider.createRefund(params)).catch(() => ({
      kind: 'unknown' as const,
      reason: 'timeout',
    }));
    let observed: RefundObservation | null = null;
    if (outcome.kind === 'observed') {
      // Acceptance is not proof: always read back.
      observed = await this.readBack(
        provider,
        outcome.refund.providerRefundId,
        attempt,
        account,
        refund,
      );
      if (!observed) {
        return this.recordOutcome(
          refund,
          {
            kind: 'unconfirmed',
            providerRefundId: outcome.refund.providerRefundId,
          },
          actor,
        );
      }
      return this.recordOutcome(refund, { kind: 'observed', observed }, actor);
    }
    return this.recordOutcome(refund, { kind: 'unconfirmed' }, actor);
  }

  // --- recheck (orders.refund) ---------------------------------------------------

  async recheck(
    orderId: string,
    refundId: string,
    body: unknown,
    actor: RefundActor,
    authorization: AuthorizationContext,
    tenant: TenantContext,
    now: Date = new Date(),
  ): Promise<OrderRefundActionResponse> {
    const input = (body ?? {}) as Record<string, unknown>;
    const provider = this.stripeFor(tenant.tenantId);
    const location = this.requireLocation(input.locationId);
    await this.authorizeRefund(
      location,
      orderId,
      'recheck',
      actor,
      authorization,
      tenant,
    );
    const order = await this.loadOrder(orderId, location, tenant.tenantId);
    const found = await this.refundOf(tenant.tenantId, refundId, order.id);
    // A refund made in the Stripe Dashboard is not CENTERIVO's request: it
    // has no key to replay and is followed from Stripe itself (M5c).
    if (found.origin !== 'CENTERIVO') {
      throw new ConflictException(
        'A refund made outside CENTERIVO is not rechecked here.',
      );
    }
    const account = await this.accountOf(order.attempt);
    const result = await withSessionLock(
      lockKey(tenant.tenantId, found.id),
      async () => {
        const refund = await this.reload(tenant.tenantId, found.id);
        return this.recheckLocked(
          provider,
          refund,
          order.attempt,
          account,
          actor,
          now,
        );
      },
    );
    if (result === null) {
      throw new ConflictException(
        'This refund is being checked right now. Try again in a moment.',
      );
    }
    return this.actionResponse(result, false, location, tenant);
  }

  private async recheckLocked(
    provider: StripePaymentIntentProvider,
    refund: RefundRecord,
    attempt: LoadedOrder['attempt'],
    account: PaymentAccountContext,
    actor: RefundActor,
    now: Date,
  ): Promise<RefundRecord> {
    const status = refund.status as PaymentRefundStatus;
    if (
      status === 'FAILED' ||
      status === 'CANCELED' ||
      status === 'NOT_CREATED' ||
      status === 'FAILED_AFTER_SUCCESS'
    ) {
      return refund;
    }
    // Its Stripe id is known: read it back.
    if (refund.providerRefundId) {
      const observed = await this.readBack(
        provider,
        refund.providerRefundId,
        attempt,
        account,
        refund,
      );
      return observed
        ? this.recordOutcome(refund, { kind: 'observed', observed }, actor)
        : refund;
    }
    if (status === 'PENDING' || status === 'SUCCEEDED') return refund;
    // Never sent (the sender stopped before Stripe was asked): provably not
    // created. Nothing can still send it: sending needs this lock and a
    // REQUESTED refund.
    if (refund.firstSentAt === null) {
      return this.recordOutcome(
        refund,
        { kind: 'not_created', evidence: 'NEVER_SENT' },
        actor,
      );
    }
    // Inside the replay window: the SAME request, with the SAME key, brings
    // back the refund if Stripe made it (or makes it exactly once).
    if (
      now.getTime() - refund.firstSentAt.getTime() <
      REFUND_REPLAY_WINDOW_MS
    ) {
      const outcome = await bounded(
        provider.createRefund(createParams(refund, attempt, account)),
      ).catch(() => ({ kind: 'unknown' as const, reason: 'timeout' }));
      if (outcome.kind !== 'observed') return refund;
      const observed = await this.readBack(
        provider,
        outcome.refund.providerRefundId,
        attempt,
        account,
        refund,
      );
      return observed
        ? this.recordOutcome(refund, { kind: 'observed', observed }, actor)
        : this.recordOutcome(
            refund,
            {
              kind: 'unconfirmed',
              providerRefundId: outcome.refund.providerRefundId,
            },
            actor,
          );
    }
    // Past it: the payment's complete refund history at Stripe.
    const listed = await bounded(
      provider.listRefundsFor({
        reference: attempt.providerReference!,
        account,
      }),
    ).catch(() => null);
    const ours = listed?.refunds.find((r) => r.centerivoRefundId === refund.id);
    if (ours) {
      if (!matchesOperation(ours, refund)) {
        // Our id on a refund for another amount or currency: never
        // recorded as ours; flagged for people.
        await this.flagAnomaly(refund, 'HISTORY_MISMATCH');
        return refund;
      }
      return this.recordOutcome(
        refund,
        { kind: 'observed', observed: ours },
        actor,
      );
    }
    const recorded = await this.prisma.paymentRefund.findMany({
      where: {
        tenantId: refund.tenantId,
        paymentAttemptId: refund.paymentAttemptId,
        providerRefundId: { not: null },
      },
      select: { providerRefundId: true },
    });
    const evidence = notCreatedEvidenceFor({
      refundId: refund.id,
      amountMinorUnits: refund.amountMinorUnits,
      firstSentAt: refund.firstSentAt,
      now,
      listed,
      recordedProviderRefundIds: new Set(
        recorded.map((r) => r.providerRefundId!),
      ),
    });
    // Not conclusively absent: it stays UNKNOWN, its amount reserved.
    if (!evidence) return refund;
    return this.recordOutcome(refund, { kind: 'not_created', evidence }, actor);
  }

  // --- late-failure review (orders.refund) ----------------------------------------

  async review(
    orderId: string,
    refundId: string,
    body: unknown,
    actor: RefundActor,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<OrderRefundActionResponse> {
    const input = (body ?? {}) as Record<string, unknown>;
    this.stripeFor(tenant.tenantId);
    const location = this.requireLocation(input.locationId);
    await this.authorizeRefund(
      location,
      orderId,
      'review',
      actor,
      authorization,
      tenant,
    );
    const note = validateNote(input.note, true)!;
    const order = await this.loadOrder(orderId, location, tenant.tenantId);
    const refund = await this.refundOf(tenant.tenantId, refundId, order.id);
    if (refund.status !== 'FAILED_AFTER_SUCCESS') {
      throw new ConflictException(
        'Only a refund whose money came back is reviewed.',
      );
    }
    if (refund.lateFailureReviewedAt !== null) {
      throw new ConflictException('This refund has already been reviewed.');
    }
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.paymentRefund.updateMany({
        where: {
          id: refund.id,
          tenantId: tenant.tenantId,
          status: 'FAILED_AFTER_SUCCESS',
          lateFailureReviewedAt: null,
        },
        // The database stamps the time.
        data: {
          lateFailureReviewedAt: new Date(),
          lateFailureReviewedByInternalUserId: actor.id,
          lateFailureReviewNote: note,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('This refund has already been reviewed.');
      }
      await this.syncObligation(tx, tenant.tenantId, refund.paymentAttemptId);
      await this.audit.recordOrderRefundAction(tx, {
        actorInternalUserId: actor.id,
        action: 'order.refund_late_failure_reviewed',
        orderId: order.id,
        refundId: refund.id,
        amountMinorUnits: refund.amountMinorUnits,
        currency: refund.currency,
        reasonCode: refund.reasonCode,
        status: 'FAILED_AFTER_SUCCESS',
        detail: { hasNote: true },
      });
    });
    return this.actionResponse(
      await this.reload(tenant.tenantId, refund.id),
      false,
      location,
      tenant,
    );
  }

  // --- recording outcomes -------------------------------------------------------

  // Records what Stripe's read-back says (or that it could not be confirmed),
  // with the obligation and the audit, in one transaction. The status moves
  // only from the one just read (a concurrent writer wins, nothing is
  // overwritten); the database checks every move.
  async recordOutcome(
    refund: RefundRecord,
    outcome:
      | { kind: 'observed'; observed: RefundObservation }
      | { kind: 'unconfirmed'; providerRefundId?: string }
      | {
          kind: 'not_created';
          evidence: 'NEVER_SENT' | 'STRIPE_HISTORY_VERIFIED';
        },
    actor: RefundActor,
  ): Promise<RefundRecord> {
    const from = refund.status as PaymentRefundStatus;
    let to: PaymentRefundStatus = from;
    const data: Prisma.PaymentRefundUpdateManyMutationInput = {};
    if (outcome.kind === 'observed') {
      const transition = transitionFor(from, outcome.observed.state);
      if (transition.kind === 'anomaly') {
        // Never written as a status; recorded in its history for people.
        await this.flagAnomaly(
          refund,
          `RECORDED_${from}_STRIPE_${outcome.observed.state.toUpperCase()}`,
        );
        return refund;
      }
      if (transition.kind === 'move') to = transition.to;
      if (refund.providerRefundId === null) {
        data.providerRefundId = outcome.observed.providerRefundId;
      }
      if (
        (to === 'FAILED' ||
          to === 'CANCELED' ||
          to === 'FAILED_AFTER_SUCCESS') &&
        outcome.observed.failureReason
      ) {
        data.providerFailureReason = outcome.observed.failureReason;
      }
    } else if (outcome.kind === 'unconfirmed') {
      if (from === 'REQUESTED') to = 'UNKNOWN';
      if (refund.providerRefundId === null && outcome.providerRefundId) {
        data.providerRefundId = outcome.providerRefundId;
      }
    } else {
      to = 'NOT_CREATED';
      data.notCreatedEvidence = outcome.evidence;
    }
    if (to === from && data.providerRefundId === undefined) return refund;
    if (to !== from) data.status = to;

    try {
      await this.writeOutcome(refund, from, to, data, outcome, actor);
    } catch (error) {
      // A database guard refused what Stripe reported (it should never):
      // the Stripe refund id is still kept, the refund left UNKNOWN (its
      // amount reserved) and flagged, so it is never lost or re-sent.
      if (
        outcome.kind !== 'not_created' &&
        from === 'REQUESTED' &&
        data.providerRefundId !== undefined &&
        isDatabaseRefusal(error)
      ) {
        await this.prisma.paymentRefund
          .updateMany({
            where: {
              id: refund.id,
              tenantId: refund.tenantId,
              status: 'REQUESTED',
            },
            data: {
              status: 'UNKNOWN',
              providerRefundId: data.providerRefundId as string,
            },
          })
          .catch(() => undefined);
        await this.flagAnomaly(refund, 'OUTCOME_REFUSED_BY_DATABASE');
      }
      throw error;
    }
    return this.reload(refund.tenantId, refund.id);
  }

  private async writeOutcome(
    refund: RefundRecord,
    from: PaymentRefundStatus,
    to: PaymentRefundStatus,
    data: Prisma.PaymentRefundUpdateManyMutationInput,
    outcome:
      | { kind: 'observed' | 'unconfirmed' }
      | { kind: 'not_created'; evidence: string },
    actor: RefundActor,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const moved = await tx.paymentRefund.updateMany({
        where: { id: refund.id, tenantId: refund.tenantId, status: from },
        data,
      });
      if (moved.count !== 1) return;
      await this.syncObligation(tx, refund.tenantId, refund.paymentAttemptId);
      if (to !== from) {
        await this.audit.recordOrderRefundAction(tx, {
          actorInternalUserId: actor.id,
          action: auditActionFor(to),
          orderId: refund.orderId,
          refundId: refund.id,
          amountMinorUnits: refund.amountMinorUnits,
          currency: refund.currency,
          reasonCode: refund.reasonCode,
          status: to,
          detail: {
            from,
            ...(outcome.kind === 'not_created'
              ? { evidence: outcome.evidence }
              : {}),
          },
        });
      }
    });
  }

  // Something about a refund people must look at (Stripe's answer could not
  // be followed, or a database guard refused it): an attributed SYSTEM entry
  // in its append-only history. Never a status change.
  private async flagAnomaly(refund: RefundRecord, code: string): Promise<void> {
    this.logger.warn(`refund ${refund.id}: needs attention (${code})`);
    await this.prisma.paymentRefundEvent
      .create({
        data: {
          tenantId: refund.tenantId,
          refundId: refund.id,
          action: 'NEEDS_ATTENTION',
          actorKind: 'SYSTEM',
          detail: { code: code.slice(0, 64) },
        },
      })
      .catch(() => undefined);
  }

  // See refund-obligation-sync.ts (shared with refund reconciliation).
  private syncObligation(
    tx: Prisma.TransactionClient,
    tenantId: string,
    paymentAttemptId: string,
  ): Promise<void> {
    return syncRefundObligation(tx, tenantId, paymentAttemptId);
  }

  // --- Stripe -------------------------------------------------------------------

  // Before a refund is recorded: the payment as Stripe holds it, and every
  // refund of it, agree with our records. Anything else fails closed: a
  // refund made in the Dashboard that is not recorded here, a different
  // amount, a dispute, an unreadable or incomplete history.
  private async verifyWithStripe(
    provider: StripePaymentIntentProvider,
    attempt: LoadedOrder['attempt'],
    account: PaymentAccountContext,
    rows: readonly RefundRecord[],
  ): Promise<void> {
    const reference = attempt.providerReference!;
    const facts = await bounded(
      provider.refundFactsFor({ reference, account }),
    ).catch(() => null);
    if (!facts) {
      throw new ServiceUnavailableException(
        'The payment could not be verified with Stripe. Nothing was refunded; try again in a moment.',
      );
    }
    if (
      facts.status !== 'succeeded' ||
      facts.amount !== attempt.amount ||
      facts.amountReceived !== attempt.amount ||
      facts.currency !== attempt.currency.toUpperCase()
    ) {
      throw new ConflictException(
        'Stripe’s record of this payment does not match. Nothing was refunded; contact support.',
      );
    }
    if (facts.chargeDisputed !== false) {
      throw new ConflictException(
        'This payment is disputed (or its dispute status is unknown). It cannot be refunded here.',
      );
    }
    const accepted = rows
      .filter((r) => r.status === 'PENDING' || r.status === 'SUCCEEDED')
      .reduce((sum, r) => sum + r.amountMinorUnits, 0);
    if (facts.chargeAmountRefunded !== accepted) {
      throw new ConflictException(
        'Stripe shows refunds of this payment that are not recorded here yet. Nothing was refunded; contact support.',
      );
    }
    const listed = await bounded(
      provider.listRefundsFor({ reference, account }),
    ).catch(() => null);
    if (!listed || !listed.complete) {
      throw new ServiceUnavailableException(
        'This payment’s refunds could not be fully read from Stripe. Nothing was refunded; try again in a moment.',
      );
    }
    const atStripe = new Set(
      listed.refunds
        .filter(
          (r) =>
            r.state === 'pending' ||
            r.state === 'requires_action' ||
            r.state === 'succeeded' ||
            r.state === 'unknown',
        )
        .map((r) => r.providerRefundId),
    );
    const recorded = new Set(
      rows
        .filter((r) => r.status === 'PENDING' || r.status === 'SUCCEEDED')
        .map((r) => r.providerRefundId!),
    );
    const same =
      atStripe.size === recorded.size &&
      [...atStripe].every((id) => recorded.has(id));
    if (!same) {
      throw new ConflictException(
        'Stripe’s refunds of this payment do not match the records here (for example a refund made in the Stripe Dashboard). Nothing was refunded; contact support.',
      );
    }
  }

  // One refund as Stripe holds it now, only if it is THIS operation's.
  private async readBack(
    provider: StripePaymentIntentProvider,
    providerRefundId: string,
    attempt: LoadedOrder['attempt'],
    account: PaymentAccountContext,
    refund: RefundRecord,
  ): Promise<RefundObservation | null> {
    const observed = await bounded(
      provider.retrieveRefund({
        providerRefundId,
        reference: attempt.providerReference!,
        account,
      }),
    ).catch(() => null);
    if (!observed || !matchesOperation(observed, refund)) return null;
    return observed;
  }

  // --- helpers -------------------------------------------------------------------

  private executionAvailableFor(tenantId: string): boolean {
    return (
      restaurantRefundsEnabled() &&
      this.provider instanceof StripePaymentIntentProvider &&
      this.provider.allowsTenant(tenantId)
    );
  }

  private stripeFor(tenantId: string): StripePaymentIntentProvider {
    if (!this.executionAvailableFor(tenantId)) {
      throw new NotFoundException(NOT_AVAILABLE);
    }
    return this.provider as StripePaymentIntentProvider;
  }

  private requireLocation(locationId: unknown): string {
    if (typeof locationId !== 'string' || locationId.trim().length === 0) {
      throw new BadRequestException('locationId is required.');
    }
    return locationId;
  }

  private assertSameBusiness(actor: RefundActor, tenant: TenantContext): void {
    if (actor.tenantId !== tenant.tenantId) {
      throw new NotFoundException(NOT_FOUND);
    }
  }

  // `orders.refund` at the location, before any order data is read; a
  // denial is audited (who, which order id, what was attempted).
  private async authorizeRefund(
    locationId: string,
    orderId: string,
    attempted: 'request' | 'recheck' | 'review',
    actor: RefundActor,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<void> {
    this.assertSameBusiness(actor, tenant);
    if (authorization.canActOnLocation('orders.refund', locationId)) return;
    await this.prisma
      .$transaction((tx) =>
        this.audit.recordOrderRefundDenied(tx, {
          actorInternalUserId: actor.id,
          orderId: OUR_ID.test(orderId) ? orderId : 'invalid',
          attempted,
        }),
      )
      .catch((error: unknown) => {
        this.logger.error(
          `could not record a denied refund attempt (${
            error instanceof Error ? error.name : 'unknown error'
          })`,
        );
      });
    throw new ForbiddenException(
      'You are not authorized to perform this action for this location.',
    );
  }

  private async loadOrder(
    orderId: string,
    locationId: string,
    tenantId: string,
  ): Promise<LoadedOrder> {
    if (!OUR_ID.test(orderId)) throw new NotFoundException(NOT_FOUND);
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId, locationId },
      select: {
        id: true,
        status: true,
        currency: true,
        orderNumber: true,
        locationId: true,
        paymentAttemptId: true,
        paymentAttempt: {
          select: {
            id: true,
            tenantId: true,
            provider: true,
            status: true,
            paymentState: true,
            providerReference: true,
            providerAccountId: true,
            amount: true,
            currency: true,
            reconciliationRequired: true,
          },
        },
        refundObligation: {
          select: { id: true, amountMinorUnits: true, status: true },
        },
      },
    });
    // The order's payment is the same business's (composite keys guarantee
    // it; refused here too rather than trusted).
    if (!order || order.paymentAttempt.tenantId !== tenantId) {
      throw new NotFoundException(NOT_FOUND);
    }
    return {
      id: order.id,
      status: String(order.status),
      currency: order.currency,
      orderNumber: order.orderNumber,
      locationId: order.locationId,
      paymentAttemptId: order.paymentAttemptId,
      attempt: {
        ...order.paymentAttempt,
        status: String(order.paymentAttempt.status),
      },
      obligation: order.refundObligation,
    };
  }

  // ESP-04 M5d — read-only signals from M5c's reconciliation: a refund
  // flagged NEEDS_ATTENTION in the last week with no change to it since
  // (reconciliation re-flags a persisting anomaly daily), and an unresolved
  // reconciliation case on the payment. Nothing here resolves anything.
  private async attentionOf(
    tenantId: string,
    paymentAttemptId: string,
    refundIds: string[],
  ): Promise<{ attentionRefundIds: string[]; paymentNeedsAttention: boolean }> {
    const since = new Date(Date.now() - ATTENTION_WINDOW_MS);
    const [events, openCase] = await Promise.all([
      refundIds.length === 0
        ? Promise.resolve([])
        : this.prisma.paymentRefundEvent.findMany({
            where: {
              tenantId,
              refundId: { in: refundIds },
              createdAt: { gt: since },
            },
            select: { refundId: true, action: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          }),
      this.prisma.paymentReconciliationCase.findFirst({
        where: { tenantId, paymentAttemptId, status: { not: 'RESOLVED' } },
        select: { id: true },
      }),
    ]);
    // The latest recent event of each refund decides: a flag not followed
    // by any change still stands.
    const latest = new Map<string, string>();
    for (const e of events) latest.set(e.refundId, e.action);
    return {
      attentionRefundIds: refundIds.filter(
        (id) => latest.get(id) === 'NEEDS_ATTENTION',
      ),
      paymentNeedsAttention: openCase !== null,
    };
  }

  private refundsOf(
    tenantId: string,
    paymentAttemptId: string,
  ): Promise<RefundRecord[]> {
    return this.prisma.paymentRefund.findMany({
      where: { tenantId, paymentAttemptId },
      include: { requestedBy: { select: { id: true, displayName: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  private async refundOf(
    tenantId: string,
    refundId: string,
    orderId: string,
  ): Promise<RefundRecord> {
    if (!OUR_ID.test(refundId)) throw new NotFoundException(NOT_FOUND);
    const refund = await this.prisma.paymentRefund.findFirst({
      where: { id: refundId, tenantId, orderId },
      include: { requestedBy: { select: { id: true, displayName: true } } },
    });
    if (!refund) throw new NotFoundException(NOT_FOUND);
    return refund;
  }

  private reload(tenantId: string, refundId: string): Promise<RefundRecord> {
    return this.prisma.paymentRefund.findFirstOrThrow({
      where: { id: refundId, tenantId },
      include: { requestedBy: { select: { id: true, displayName: true } } },
    });
  }

  // The payment's own connected account, still the business's own.
  private async accountOf(
    attempt: LoadedOrder['attempt'],
  ): Promise<PaymentAccountContext> {
    const account =
      attempt.providerAccountId === null
        ? null
        : await paymentAccountForAttempt(this.prisma, attempt);
    if (
      !account ||
      account.connectedAccountId === null ||
      account.connectedAccountId !== attempt.providerAccountId
    ) {
      throw new ConflictException(
        'This payment’s Stripe account is no longer the business’s account. Contact support.',
      );
    }
    return account;
  }

  private async replayed(
    tenantId: string,
    requestId: string,
    fingerprint: string,
  ): Promise<RefundRecord | null> {
    const existing = await this.prisma.paymentRefund.findUnique({
      where: {
        tenantId_clientRequestId: { tenantId, clientRequestId: requestId },
      },
      include: { requestedBy: { select: { id: true, displayName: true } } },
    });
    if (!existing) return null;
    if (existing.requestFingerprint !== fingerprint) {
      throw new ConflictException(
        'This request id was already used for a different refund. Start a new refund instead.',
      );
    }
    return existing;
  }

  private async actionResponse(
    refund: RefundRecord,
    replayed: boolean,
    locationId: string,
    tenant: TenantContext,
  ): Promise<OrderRefundActionResponse> {
    const order = await this.loadOrder(
      refund.orderId,
      locationId,
      tenant.tenantId,
    );
    const rows = await this.refundsOf(tenant.tenantId, order.paymentAttemptId);
    return {
      refund: viewOf(refund),
      replayed,
      balances: balancesOf(order, rows),
      obligation: obligationViewOf(order, rows),
    };
  }
}

// --- pure helpers -----------------------------------------------------------------

function lockKey(tenantId: string, refundId: string): string {
  return `esp04-refund:${tenantId}:${refundId}`;
}

function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error('Stripe call timed out')),
        REFUND_STRIPE_TIMEOUT_MS,
      );
      timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

// The Stripe request of one operation: always the same for every retry of
// it (Stripe refuses a key reused with other parameters).
function createParams(
  refund: RefundRecord,
  attempt: LoadedOrder['attempt'],
  account: PaymentAccountContext,
) {
  return {
    reference: attempt.providerReference!,
    account,
    amountMinorUnits: refund.amountMinorUnits,
    currency: refund.currency,
    reason: stripeReasonFor(refund.reasonCode),
    refundId: refund.id,
    tenantId: refund.tenantId,
    idempotencyKey: refund.idempotencyKey!,
  };
}

function stripeReasonFor(reasonCode: string | null): StripeRefundReason {
  return reasonCode === 'DUPLICATE_CHARGE'
    ? 'duplicate'
    : 'requested_by_customer';
}

// A Stripe refund is this operation's only when it carries our id, for our
// amount and currency.
function matchesOperation(
  observed: RefundObservation,
  refund: RefundRecord,
): boolean {
  return (
    observed.centerivoRefundId === refund.id &&
    observed.amountMinorUnits === refund.amountMinorUnits &&
    observed.currency === refund.currency &&
    (refund.providerRefundId === null ||
      refund.providerRefundId === observed.providerRefundId)
  );
}

function refundablePayment(order: LoadedOrder): boolean {
  const a = order.attempt;
  return (
    a.provider === 'stripe' &&
    a.status === 'SUCCEEDED' &&
    (a.paymentState === null || a.paymentState === 'SUCCEEDED') &&
    a.providerReference !== null &&
    /^pi_[A-Za-z0-9]{1,100}$/.test(a.providerReference) &&
    a.providerAccountId !== null &&
    a.amount > 0
  );
}

function assertNoUnresolved(rows: readonly { status: string }[]): void {
  if (rows.some((r) => r.status === 'REQUESTED' || r.status === 'UNKNOWN')) {
    throw new ConflictException(
      'A refund of this payment is still waiting for Stripe’s answer. Recheck it before asking for another.',
    );
  }
}

function rowOf(r: {
  status: string;
  amountMinorUnits: number;
  origin: string;
  succeededAt: Date | null;
  lateFailureReviewedAt: Date | null;
}): RefundRow {
  return {
    status: r.status as PaymentRefundStatus,
    amountMinorUnits: r.amountMinorUnits,
    origin: r.origin === 'EXTERNAL' ? 'EXTERNAL' : 'CENTERIVO',
    succeededAt: r.succeededAt,
    lateFailureReviewedAt: r.lateFailureReviewedAt,
  };
}

function balancesOf(
  order: LoadedOrder,
  rows: readonly RefundRecord[],
): OrderRefundBalances {
  const summary = summarizeRefunds(order.attempt.amount, rows.map(rowOf));
  return {
    chargedMinorUnits: summary.chargedMinorUnits,
    refundedMinorUnits: summary.succeededMinorUnits,
    inProgressMinorUnits: summary.inFlightMinorUnits,
    refundableMinorUnits: summary.refundableMinorUnits,
    lateFailureNeedsReview: summary.lateFailureNeedsReview,
    unresolved: rows.some(
      (r) => r.status === 'REQUESTED' || r.status === 'UNKNOWN',
    ),
  };
}

function obligationViewOf(
  order: LoadedOrder,
  rows: readonly RefundRecord[],
): OrderRefundObligationView | null {
  if (!order.obligation) return null;
  const standing = obligationStanding(
    order.obligation.amountMinorUnits,
    rows.map(rowOf),
    order.obligation.status,
  );
  return obligationView(
    order.obligation.amountMinorUnits,
    order.obligation.status,
    standing,
  );
}

function obligationView(
  amountMinorUnits: number,
  recordedStatus: string,
  standing: ReturnType<typeof obligationStanding>,
): OrderRefundObligationView {
  return {
    amountMinorUnits,
    recordedStatus: recordedStatus as OrderRefundObligationStatus,
    refundedMinorUnits: standing.refundedMinorUnits,
    inProgressMinorUnits: standing.inProgressMinorUnits,
    outstandingMinorUnits: standing.outstandingMinorUnits,
    fullyRefunded: standing.fullyRefunded,
    needsAttention: standing.needsAttention,
  };
}

function viewOf(r: RefundRecord): OrderRefundView {
  const reason = r.reasonCode as OrderRefundReasonCode | null;
  return {
    id: r.id,
    origin: r.origin === 'EXTERNAL' ? 'EXTERNAL' : 'CENTERIVO',
    status: r.status as OrderRefundStatus,
    amountMinorUnits: r.amountMinorUnits,
    currency: r.currency,
    reasonCode: r.reasonCode,
    reasonLabel:
      reason && reason in ORDER_REFUND_REASON_LABELS
        ? ORDER_REFUND_REASON_LABELS[reason]
        : null,
    note: r.note,
    requestedBy: r.requestedBy
      ? { id: r.requestedBy.id, displayName: r.requestedBy.displayName }
      : null,
    createdAt: r.createdAt.toISOString(),
    succeededAt: r.succeededAt?.toISOString() ?? null,
    failedAfterSuccessAt: r.failedAfterSuccessAt?.toISOString() ?? null,
    lateFailureReviewedAt: r.lateFailureReviewedAt?.toISOString() ?? null,
    lateFailureReviewNote: r.lateFailureReviewNote,
    notCreatedEvidence: r.notCreatedEvidence,
  };
}

function auditActionFor(status: PaymentRefundStatus): string {
  switch (status) {
    case 'SUCCEEDED':
      return 'order.refund_succeeded';
    case 'PENDING':
      return 'order.refund_pending';
    case 'UNKNOWN':
      return 'order.refund_unknown';
    case 'FAILED':
    case 'CANCELED':
      return 'order.refund_failed';
    case 'NOT_CREATED':
      return 'order.refund_not_created';
    case 'FAILED_AFTER_SUCCESS':
      return 'order.refund_returned';
    default:
      return 'order.refund_updated';
  }
}

interface ValidRequest {
  requestId: string;
  amountMinorUnits: number;
  currency: string;
  reasonCode: OrderRefundReasonCode;
  note: string | null;
  expectedReservedMinorUnits: number;
}

function validateRequest(input: Record<string, unknown>): ValidRequest {
  const {
    requestId,
    amountMinorUnits,
    currency,
    reasonCode,
    expectedReservedMinorUnits,
  } = input;
  if (typeof requestId !== 'string' || !UUID.test(requestId)) {
    throw new BadRequestException('requestId must be a lower-case UUID.');
  }
  if (
    typeof expectedReservedMinorUnits !== 'number' ||
    !Number.isSafeInteger(expectedReservedMinorUnits) ||
    expectedReservedMinorUnits < 0
  ) {
    throw new BadRequestException(
      'expectedReservedMinorUnits (refunded plus in progress, as shown) is required.',
    );
  }
  if (
    typeof amountMinorUnits !== 'number' ||
    !Number.isSafeInteger(amountMinorUnits) ||
    amountMinorUnits <= 0
  ) {
    throw new BadRequestException(
      'amountMinorUnits must be a positive whole number of minor units.',
    );
  }
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new BadRequestException('currency must be a three-letter code.');
  }
  if (
    typeof reasonCode !== 'string' ||
    !(ORDER_REFUND_REASON_CODES as readonly string[]).includes(reasonCode)
  ) {
    throw new BadRequestException('reasonCode is not a known refund reason.');
  }
  const note = validateNote(input.note, reasonCode === 'OTHER');
  return {
    requestId,
    amountMinorUnits,
    currency,
    reasonCode: reasonCode as OrderRefundReasonCode,
    note,
    expectedReservedMinorUnits,
  };
}

// The refunds of the payment (refunded + in progress) must still be what
// the staff member saw when they decided: otherwise someone refunded in the
// meantime (or the same refund was resubmitted as a new request), and this
// one is refused rather than added on top.
function assertExpectedReserved(
  reservedMinorUnits: number,
  request: ValidRequest,
): void {
  if (reservedMinorUnits !== request.expectedReservedMinorUnits) {
    throw new ConflictException(
      'The refunds of this order changed since you looked. Refresh and check before refunding again.',
    );
  }
}

function validateNote(note: unknown, required: boolean): string | null {
  if (note === undefined || note === null || note === '') {
    if (required) throw new BadRequestException('A note is required.');
    return null;
  }
  if (
    typeof note !== 'string' ||
    note.trim().length === 0 ||
    note.length > ORDER_REFUND_NOTE_MAX_LENGTH ||
    NOTE_FORBIDDEN.test(note)
  ) {
    throw new BadRequestException(
      `A note is plain text of 1-${ORDER_REFUND_NOTE_MAX_LENGTH} characters.`,
    );
  }
  return note;
}

// The server's fingerprint of a request: everything that was asked, by
// whom, for which order — a reused request id with anything else differs.
function fingerprintOf(values: {
  tenantId: string;
  orderId: string;
  locationId: string;
  actorId: string;
  requestId: string;
  amountMinorUnits: number;
  currency: string;
  reasonCode: string;
  note: string | null;
  expectedReservedMinorUnits: number;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        values.tenantId,
        values.orderId,
        values.locationId,
        values.actorId,
        values.requestId,
        values.amountMinorUnits,
        values.currency,
        values.reasonCode,
        values.note,
        values.expectedReservedMinorUnits,
      ]),
    )
    .digest('hex');
}

// A refusal by one of the refund guards (a raised exception in a trigger
// or a CHECK), as opposed to the database being unreachable.
function isDatabaseRefusal(error: unknown): boolean {
  const raw =
    typeof error === 'object' && error !== null
      ? (error as { message?: unknown }).message
      : undefined;
  return (
    typeof raw === 'string' &&
    /payment refund|check constraint|cannot exceed|cannot move/i.test(raw)
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}

// A database guard's refusal, as the staff member should hear it. Anything
// else is not ours to explain.
function refusalFrom(error: unknown): unknown {
  const raw =
    typeof error === 'object' && error !== null
      ? (error as { message?: unknown }).message
      : undefined;
  const message = typeof raw === 'string' ? raw : '';
  if (/left to refund/.test(message)) {
    return new ConflictException(
      'The refund is more than is left to refund. Refresh and try again.',
    );
  }
  if (/must be reviewed/.test(message)) {
    return new ConflictException(
      'A refund of this payment came back and must be reviewed before another is made.',
    );
  }
  if (
    /confirmed Stripe payment|needs reconciliation|completed, rejected or cancelled|account the payment was made on/.test(
      message,
    )
  ) {
    return new ConflictException('This payment cannot be refunded here.');
  }
  return error;
}
