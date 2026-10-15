import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  GIFT_CARD_MAX_VALUE_MINOR_UNITS,
  ORDER_CANCELLATION_REASON_CODES,
  ORDER_CLOSURE_NOTE_MAX_LENGTH,
  ORDER_CLOSURE_REASON_LABELS,
  ORDER_REJECTION_REASON_CODES,
  type CloseOrderResponse,
  type OrderClosureKind,
  type OrderClosureReasonCode,
  type OrderRefundObligationStatus,
  type OrderStatus,
  type StoreOrderClosureSummary,
} from '@mocha-house/contracts';
import type { Prisma, TenantContext } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { InternalAuditService } from '../../audit/internal-audit.service';
import type { AuthorizationContext } from '../../internal-auth/authorization/authorization-context';
import { isOrderClosureEnabled } from './order-closure.config';

const NOT_FOUND = 'Order not found for this location.';
const CANCELLABLE_FROM: ReadonlySet<string> = new Set([
  'ACCEPTED',
  'PREPARING',
  'READY',
]);
const CLOSED: ReadonlySet<string> = new Set(['REJECTED', 'CANCELLED']);
// A note is plain text: control characters (other than tab / newline), and
// invisible or direction-changing characters that could disguise what a note
// says in a staff view or an export (zero-width, bidi overrides and isolates,
// line / paragraph separators, BOM), are refused.
const NOTE_FORBIDDEN = new RegExp(
  '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F' +
    '\u200B-\u200F\u2028-\u202E\u2060-\u2069\uFEFF]',
);

export interface CloseOrderInput {
  kind: OrderClosureKind;
  orderId: string;
  locationId: unknown;
  // Required for a cancellation (the status the staff member saw); a
  // rejection is always from RECEIVED.
  expectedStatus?: unknown;
  reasonCode: unknown;
  note?: unknown;
}

export interface ClosureActor {
  id: string;
  tenantId: string;
}

interface LockedOrder {
  id: string;
  status: string;
  tenantId: string;
  locationId: string;
  paymentAttemptId: string;
  currency: string;
  subtotal: number;
  promotionDiscountMinorUnits: number;
  rewardDiscountMinorUnits: number;
  giftCardTenderMinorUnits: number;
}

interface Reversals {
  giftCardRestoredMinorUnits: number;
  beansReturned: number;
  beansRecovered: number;
  loyaltyShortfallBeans: number;
  promotionUsageReleased: boolean;
  customerPromotionUsageReleased: boolean;
}

// R1 / S5b — the order closure writer: REJECT (RECEIVED -> REJECTED) and CANCEL
// (ACCEPTED / PREPARING / READY -> CANCELLED).
//
// One database transaction does everything, or nothing:
//   1. lock the Order row (tenant- and location-scoped) and decide;
//   2. conditional status change (WHERE status = the status just read);
//   3. release the regular Promotion / Coupon usage counters;
//   4. restore the gift-card tender to the card (REDEMPTION_REVERSAL);
//   5. return redeemed Mocha Beans, then recover earned and bonus Beans,
//      clamped at the balance — the rest is the recorded shortfall;
//   6. a DUE refund obligation for the card-paid amount, only when a card
//      charge genuinely succeeded;
//   7. OrderClosure, the status-history row and the audit event.
//
// Lock order (every writer that touches more than one of these takes them in
// this order, so two closures, or a closure and a checkout, cannot deadlock):
//   Order -> Promotion -> PromotionCustomerUsage -> GiftCard -> CustomerLoyaltyAccount
//
// Exactly once: the Order row lock serialises closures of the same order, the
// conditional update can succeed only from an open status, and the database
// backs it with one closure per order, one gift-card restoration per order and
// one loyalty reversal per type per order. A repeated request finds the order
// already closed and returns the existing closure without writing anything.
//
// Money: a card is never refunded here. The card-paid amount becomes an
// OrderRefundObligation in DUE; only a person (S5c) can record it settled.
@Injectable()
export class OrderClosureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: InternalAuditService,
  ) {}

  async close(
    input: CloseOrderInput,
    actor: ClosureActor,
    authorization: AuthorizationContext,
    tenant: TenantContext,
  ): Promise<CloseOrderResponse> {
    if (!isOrderClosureEnabled()) {
      throw new NotFoundException(
        'Order rejection and cancellation are not available.',
      );
    }
    // 403 for a location the caller does not hold `orders.cancel` at — before
    // any order data is read and before the detailed validation, so a caller
    // without the permission learns nothing about the request format.
    if (
      typeof input.locationId !== 'string' ||
      input.locationId.trim().length === 0
    ) {
      throw new BadRequestException('locationId is required.');
    }
    authorization.assertCanActOnLocation('orders.cancel', input.locationId);
    const request = validate(input);
    // The acting staff member belongs to the request's business (the internal
    // auth guard resolved them for it); never act across businesses.
    if (actor.tenantId !== tenant.tenantId) {
      throw new NotFoundException(NOT_FOUND);
    }

    try {
      return await this.prisma.$transaction(
        (tx) => this.closeLocked(tx, request, input.orderId, actor),
        // Row-lock waits count towards the transaction time; a busy order
        // (a checkout holding its promotion / card / Bean rows) gets a fair
        // chance, while lock_timeout below keeps any single wait bounded.
        { maxWait: 5_000, timeout: 15_000 },
      );
    } catch (error) {
      if (isLockContention(error)) {
        // Rolled back in full; nothing changed. Safe to retry.
        throw new ServiceUnavailableException(
          'This order is busy right now. Nothing was changed; try again in a moment.',
        );
      }
      throw error;
    }
  }

  private async closeLocked(
    tx: Prisma.TransactionClient,
    request: ValidRequest,
    orderId: string,
    actor: ClosureActor,
  ): Promise<CloseOrderResponse> {
    await tx.$executeRaw`SET LOCAL lock_timeout = '5s'`;
    const order = await lockOrder(tx, orderId, actor.tenantId);
    if (!order || order.locationId !== request.locationId) {
      throw new NotFoundException(NOT_FOUND);
    }

    if (CLOSED.has(order.status)) {
      if (order.status !== request.kind) {
        throw new ConflictException(
          `Order is already ${order.status.toLowerCase()}.`,
        );
      }
      // Idempotent replay: already closed the way this request asks.
      return {
        orderId: order.id,
        status: order.status as OrderStatus,
        closed: false,
        closure: await readClosureSummary(tx, order.id, order.tenantId),
      };
    }
    assertTransitionAllowed(request, order.status);

    const fromStatus = order.status as OrderStatus;
    const moved = await tx.order.updateMany({
      where: {
        id: order.id,
        tenantId: order.tenantId,
        locationId: order.locationId,
        status: fromStatus,
      },
      data: { status: request.kind },
    });
    if (moved.count !== 1) {
      // Unreachable under the row lock; refuse rather than guess.
      throw new ConflictException(
        'Order status changed since this action was requested. Refresh and try again.',
      );
    }

    const reversals: Reversals = {
      giftCardRestoredMinorUnits: 0,
      beansReturned: 0,
      beansRecovered: 0,
      loyaltyShortfallBeans: 0,
      promotionUsageReleased: false,
      customerPromotionUsageReleased: false,
    };
    Object.assign(reversals, await releasePromotionUsage(tx, order));
    reversals.giftCardRestoredMinorUnits = await restoreGiftCard(
      tx,
      order,
      actor.id,
    );
    Object.assign(reversals, await reverseLoyalty(tx, order, actor.id));
    const refundDue = await cardRefundDue(tx, order);

    const closure = await tx.orderClosure.create({
      data: {
        tenantId: order.tenantId,
        orderId: order.id,
        kind: request.kind,
        fromStatus,
        reasonCode: request.reasonCode,
        note: request.note,
        actorInternalUserId: actor.id,
        refundDueMinorUnits: refundDue,
        giftCardRestoredMinorUnits: reversals.giftCardRestoredMinorUnits,
        loyaltyShortfallBeans: reversals.loyaltyShortfallBeans,
      },
    });
    if (refundDue > 0) {
      // Born DUE (database-enforced). Nothing here, or anywhere in S5b,
      // moves it on.
      await tx.orderRefundObligation.create({
        data: {
          tenantId: order.tenantId,
          orderId: order.id,
          closureId: closure.id,
          paymentAttemptId: order.paymentAttemptId,
          amountMinorUnits: refundDue,
          currency: order.currency,
        },
      });
    }
    // The note stays on the closure only — never in status history, which
    // is the customer-facing timeline's source.
    await tx.orderStatusHistory.create({
      data: {
        tenantId: order.tenantId,
        orderId: order.id,
        status: request.kind,
      },
    });
    await this.audit.recordOrderClosed(tx, {
      actorInternalUserId: actor.id,
      orderId: order.id,
      kind: request.kind,
      fromStatus,
      reasonCode: request.reasonCode,
      reasonLabel: ORDER_CLOSURE_REASON_LABELS[request.reasonCode],
      hasNote: request.note !== null,
      refundDueMinorUnits: refundDue,
      ...reversals,
    });

    return {
      orderId: order.id,
      status: request.kind,
      closed: true,
      closure: await readClosureSummary(tx, order.id, order.tenantId),
    };
  }
}

// A lock wait that ran out (PostgreSQL lock_not_available, 55P03) or a Prisma
// interactive transaction that timed out or could not start (P2028). Both
// roll the whole closure back.
function isLockContention(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const e = error as {
    code?: unknown;
    meta?: { code?: unknown };
    message?: unknown;
  };
  return (
    e.code === 'P2028' ||
    e.code === '55P03' ||
    e.meta?.code === '55P03' ||
    (typeof e.message === 'string' && /lock timeout/i.test(e.message))
  );
}

// --- validation ------------------------------------------------------------

interface ValidRequest {
  kind: OrderClosureKind;
  locationId: string;
  expectedStatus: string | null;
  reasonCode: OrderClosureReasonCode;
  note: string | null;
}

function validate(input: CloseOrderInput): ValidRequest {
  if (
    typeof input.locationId !== 'string' ||
    input.locationId.trim().length === 0
  ) {
    throw new BadRequestException('locationId is required.');
  }
  const allowed: readonly string[] =
    input.kind === 'REJECTED'
      ? ORDER_REJECTION_REASON_CODES
      : ORDER_CANCELLATION_REASON_CODES;
  if (
    typeof input.reasonCode !== 'string' ||
    !allowed.includes(input.reasonCode)
  ) {
    throw new BadRequestException(
      `reasonCode must be one of: ${allowed.join(', ')}.`,
    );
  }
  const reasonCode = input.reasonCode as OrderClosureReasonCode;

  let note: string | null = null;
  if (input.note !== undefined && input.note !== null) {
    if (typeof input.note !== 'string') {
      throw new BadRequestException('note must be text.');
    }
    const trimmed = input.note.trim();
    if (trimmed.length > ORDER_CLOSURE_NOTE_MAX_LENGTH) {
      throw new BadRequestException(
        `note must be at most ${ORDER_CLOSURE_NOTE_MAX_LENGTH} characters.`,
      );
    }
    if (NOTE_FORBIDDEN.test(trimmed)) {
      throw new BadRequestException('note contains unsupported characters.');
    }
    note = trimmed.length > 0 ? trimmed : null;
  }
  if (reasonCode === 'OTHER' && note === null) {
    throw new BadRequestException(
      'A note is required when the reason is OTHER.',
    );
  }

  let expectedStatus: string | null = null;
  if (input.kind === 'CANCELLED') {
    if (
      typeof input.expectedStatus !== 'string' ||
      !CANCELLABLE_FROM.has(input.expectedStatus)
    ) {
      throw new BadRequestException(
        'expectedStatus must be ACCEPTED, PREPARING or READY.',
      );
    }
    expectedStatus = input.expectedStatus;
  }

  return {
    kind: input.kind,
    locationId: input.locationId,
    expectedStatus,
    reasonCode,
    note,
  };
}

function assertTransitionAllowed(request: ValidRequest, status: string): void {
  if (request.kind === 'REJECTED') {
    if (status !== 'RECEIVED') {
      throw new ConflictException(
        status === 'COMPLETED'
          ? 'Order is already completed.'
          : `Only a new order can be rejected (this one is ${status.toLowerCase()}); cancel it instead.`,
      );
    }
    return;
  }
  if (status === 'RECEIVED') {
    throw new ConflictException(
      'This order has not been accepted yet; reject it instead.',
    );
  }
  if (!CANCELLABLE_FROM.has(status)) {
    throw new ConflictException(`Order is already ${status.toLowerCase()}.`);
  }
  if (status !== request.expectedStatus) {
    throw new ConflictException(
      `Order status changed since this action was requested (now ${status}). Refresh and try again.`,
    );
  }
}

// --- the transaction steps (in lock order) ----------------------------------

async function lockOrder(
  tx: Prisma.TransactionClient,
  orderId: string,
  tenantId: string,
): Promise<LockedOrder | null> {
  const rows = await tx.$queryRaw<LockedOrder[]>`
    SELECT "id", "status"::text AS "status", "tenantId", "locationId",
           "paymentAttemptId", "currency", "subtotal",
           "promotionDiscountMinorUnits", "rewardDiscountMinorUnits",
           "giftCardTenderMinorUnits"
      FROM "Order"
     WHERE "id" = ${orderId} AND "tenantId" = ${tenantId}
       FOR NO KEY UPDATE`;
  return rows[0] ?? null;
}

// The regular Promotion / Coupon this order consumed: one total use and, when
// it counted against the customer's own limit, one per-customer use. Every
// OrderPromotionRedemption was written in the same checkout transaction that
// incremented both, so each is released exactly once with the closure. A
// counter is never driven below zero; a promotion that no longer exists has
// nothing to release.
async function releasePromotionUsage(
  tx: Prisma.TransactionClient,
  order: LockedOrder,
): Promise<
  Pick<Reversals, 'promotionUsageReleased' | 'customerPromotionUsageReleased'>
> {
  const none = {
    promotionUsageReleased: false,
    customerPromotionUsageReleased: false,
  };
  const redemption = await tx.orderPromotionRedemption.findUnique({
    where: {
      tenantId_orderId: { tenantId: order.tenantId, orderId: order.id },
    },
    select: { sourcePromotionId: true, customerId: true },
  });
  if (!redemption?.sourcePromotionId) {
    return none;
  }
  const total = await tx.promotion.updateMany({
    where: {
      id: redemption.sourcePromotionId,
      tenantId: order.tenantId,
      redemptionCount: { gt: 0 },
    },
    data: { redemptionCount: { decrement: 1 } },
  });
  let customer = 0;
  if (redemption.customerId !== null) {
    customer = (
      await tx.promotionCustomerUsage.updateMany({
        where: {
          promotionId: redemption.sourcePromotionId,
          customerId: redemption.customerId,
          tenantId: order.tenantId,
          usedCount: { gt: 0 },
        },
        data: { usedCount: { decrement: 1 } },
      })
    ).count;
  }
  // Both are reported separately on the audit event, so a counter that was
  // already at zero (and so could not be released) is visible, not silent.
  return {
    promotionUsageReleased: total.count === 1,
    customerPromotionUsageReleased: customer === 1,
  };
}

// The gift-card tender goes back to the card it came from, exactly. The card
// is found through this order's own REDEMPTION ledger entry (the
// authoritative movement), never through the snapshot's plain reference. A
// card that HQ deactivated still gets its value back. A restoration that would
// break the approved maximum balance is refused (HQ must correct the card
// first) rather than silently reduced.
async function restoreGiftCard(
  tx: Prisma.TransactionClient,
  order: LockedOrder,
  actorId: string,
): Promise<number> {
  const redemption = await tx.orderGiftCardRedemption.findUnique({
    where: {
      tenantId_orderId: { tenantId: order.tenantId, orderId: order.id },
    },
    select: { amountMinorUnits: true, currency: true },
  });
  const spent = await tx.giftCardTransaction.findMany({
    where: { tenantId: order.tenantId, orderId: order.id, type: 'REDEMPTION' },
    select: { giftCardId: true, amountMinorUnits: true },
  });
  if (
    !redemption &&
    spent.length === 0 &&
    order.giftCardTenderMinorUnits === 0
  ) {
    return 0;
  }
  const amount = redemption?.amountMinorUnits ?? -1;
  if (
    !redemption ||
    spent.length !== 1 ||
    spent[0].amountMinorUnits !== -amount ||
    amount !== order.giftCardTenderMinorUnits ||
    amount <= 0 ||
    redemption.currency !== order.currency
  ) {
    throw new ConflictException(
      "This order's gift-card records do not agree, so it cannot be closed automatically. Contact support.",
    );
  }

  const giftCardId = spent[0].giftCardId;
  const cards = await tx.$queryRaw<
    { balanceMinorUnits: number; currency: string }[]
  >`
    SELECT "balanceMinorUnits", "currency" FROM "GiftCard"
     WHERE "id" = ${giftCardId} AND "tenantId" = ${order.tenantId}
       FOR UPDATE`;
  const card = cards[0];
  if (!card || card.currency !== order.currency) {
    throw new ConflictException(
      'The gift card used on this order cannot be restored automatically. Contact support.',
    );
  }
  const balanceAfter = card.balanceMinorUnits + amount;
  if (balanceAfter > GIFT_CARD_MAX_VALUE_MINOR_UNITS) {
    throw new ConflictException(
      "Restoring this order's gift-card payment would take the card above its maximum balance. An HQ gift-card correction is needed before this order can be closed.",
    );
  }

  await tx.giftCardTransaction.create({
    data: {
      tenantId: order.tenantId,
      giftCardId,
      type: 'REDEMPTION_REVERSAL',
      amountMinorUnits: amount,
      balanceAfterMinorUnits: balanceAfter,
      orderId: order.id,
      actorInternalUserId: actorId,
    },
  });
  await tx.giftCard.updateMany({
    where: { id: giftCardId, tenantId: order.tenantId },
    data: { balanceMinorUnits: { increment: amount } },
  });
  return amount;
}

// Mocha Beans: the reward's Beans come back first, then the Beans the order
// earned (standard and bonus) are taken back — each clamped at what the
// balance can cover, so the balance never goes below zero. Whatever could not
// be taken back (the customer already spent it) is the shortfall, recorded on
// the closure so earned − recovered = shortfall always reconciles.
async function reverseLoyalty(
  tx: Prisma.TransactionClient,
  order: LockedOrder,
  actorId: string,
): Promise<
  Pick<Reversals, 'beansReturned' | 'beansRecovered' | 'loyaltyShortfallBeans'>
> {
  const entries = await tx.mochaBeanLedgerEntry.findMany({
    where: {
      tenantId: order.tenantId,
      orderId: order.id,
      type: { in: ['REDEEM', 'EARN', 'BONUS_EARN'] },
    },
    select: { type: true, amount: true, loyaltyAccountId: true },
  });
  const none = {
    beansReturned: 0,
    beansRecovered: 0,
    loyaltyShortfallBeans: 0,
  };
  if (entries.length === 0) {
    return none;
  }
  const accountIds = new Set(entries.map((e) => e.loyaltyAccountId));
  if (accountIds.size !== 1) {
    throw new ConflictException(
      "This order's Mocha Bean records do not agree, so it cannot be closed automatically. Contact support.",
    );
  }
  const accountId = entries[0].loyaltyAccountId;
  const accounts = await tx.$queryRaw<{ balance: number }[]>`
    SELECT "balance" FROM "CustomerLoyaltyAccount"
     WHERE "id" = ${accountId} AND "tenantId" = ${order.tenantId}
       FOR UPDATE`;
  if (!accounts[0]) {
    throw new ConflictException(
      'The Mocha Bean account for this order cannot be found. Contact support.',
    );
  }
  let balance = accounts[0].balance;
  const startBalance = balance;
  const result = { ...none };

  const redeem = entries.find((e) => e.type === 'REDEEM');
  if (redeem && redeem.amount < 0) {
    const returned = -redeem.amount;
    balance += returned;
    result.beansReturned = returned;
    await tx.mochaBeanLedgerEntry.create({
      data: {
        tenantId: order.tenantId,
        loyaltyAccountId: accountId,
        type: 'REDEEM_REVERSAL',
        amount: returned,
        orderId: order.id,
        actorInternalUserId: actorId,
      },
    });
  }
  for (const [earnType, reversalType] of [
    ['EARN', 'EARN_REVERSAL'],
    ['BONUS_EARN', 'BONUS_EARN_REVERSAL'],
  ] as const) {
    const earned = entries.find((e) => e.type === earnType);
    if (!earned || earned.amount <= 0) continue;
    const recovered = Math.min(earned.amount, balance);
    result.loyaltyShortfallBeans += earned.amount - recovered;
    if (recovered > 0) {
      balance -= recovered;
      result.beansRecovered += recovered;
      await tx.mochaBeanLedgerEntry.create({
        data: {
          tenantId: order.tenantId,
          loyaltyAccountId: accountId,
          type: reversalType,
          amount: -recovered,
          orderId: order.id,
          actorInternalUserId: actorId,
        },
      });
    }
  }
  if (balance !== startBalance) {
    await tx.customerLoyaltyAccount.updateMany({
      where: { id: accountId, tenantId: order.tenantId },
      data: { balance: { increment: balance - startBalance } },
    });
  }
  return result;
}

// What is owed back on the card: exactly the external charge, and only when
// that charge genuinely succeeded. An order whose own figures disagree with
// its payment, or whose card payment is not definitively SUCCEEDED, is not
// closed automatically — a refund must never be owed for money that was not
// taken, and money that was taken must never be forgotten.
async function cardRefundDue(
  tx: Prisma.TransactionClient,
  order: LockedOrder,
): Promise<number> {
  const attempt = await tx.paymentAttempt.findUnique({
    where: {
      tenantId_id: { tenantId: order.tenantId, id: order.paymentAttemptId },
    },
    select: {
      amount: true,
      currency: true,
      status: true,
      paymentState: true,
      providerReference: true,
      reconciliationRequired: true,
    },
  });
  const external =
    order.subtotal -
    order.promotionDiscountMinorUnits -
    order.rewardDiscountMinorUnits -
    order.giftCardTenderMinorUnits;
  if (
    !attempt ||
    attempt.amount !== external ||
    attempt.currency !== order.currency ||
    attempt.amount < 0
  ) {
    throw new ConflictException(
      "This order's payment records do not agree, so it cannot be closed automatically. Contact support.",
    );
  }
  if (attempt.amount === 0) {
    return 0;
  }
  const genuinelySucceeded =
    attempt.status === 'SUCCEEDED' &&
    (attempt.paymentState === null || attempt.paymentState === 'SUCCEEDED') &&
    !attempt.reconciliationRequired &&
    attempt.providerReference !== null &&
    attempt.providerReference !== 'no-charge';
  if (!genuinelySucceeded) {
    throw new ConflictException(
      "This order's card payment is not confirmed, so it cannot be closed until the payment is reconciled. Contact support.",
    );
  }
  return attempt.amount;
}

export async function readClosureSummary(
  db: Prisma.TransactionClient | PrismaService,
  orderId: string,
  tenantId: string,
): Promise<StoreOrderClosureSummary> {
  const closure = await db.orderClosure.findUniqueOrThrow({
    where: { tenantId_orderId: { tenantId, orderId } },
    include: { refundObligation: { select: { status: true } } },
  });
  return toClosureSummary(closure, true);
}

// `includeNote`: the internal staff note is shown only to people who may close
// orders (`orders.cancel`) at the order's location; anyone else gets null.
export function toClosureSummary(
  closure: Prisma.OrderClosureGetPayload<{
    include: { refundObligation: { select: { status: true } } };
  }>,
  includeNote: boolean,
): StoreOrderClosureSummary {
  return {
    kind: closure.kind as OrderClosureKind,
    fromStatus: closure.fromStatus,
    reasonCode: closure.reasonCode,
    reasonLabel:
      ORDER_CLOSURE_REASON_LABELS[
        closure.reasonCode as OrderClosureReasonCode
      ] ?? closure.reasonCode,
    note: includeNote ? closure.note : null,
    closedAt: closure.createdAt.toISOString(),
    refundDueMinorUnits: closure.refundDueMinorUnits,
    refundStatus:
      (closure.refundObligation?.status as OrderRefundObligationStatus) ?? null,
    giftCardRestoredMinorUnits: closure.giftCardRestoredMinorUnits,
    loyaltyShortfallBeans: closure.loyaltyShortfallBeans,
  };
}
