import { ConflictException } from '@nestjs/common';
import { CHECKOUT_RESOURCE_UNAVAILABLE } from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';
import type { PrismaService } from '../prisma/prisma.service';

// ESP-03 PR 8 — pre-charge financial holds.
//
// Before a food-order payment is sent to the provider, everything the order
// will spend is reserved in the SAME transaction that creates the payment
// attempt and its frozen checkout:
//   * PROMOTION_REDEMPTION — one redemption of the order's promotion or
//     coupon, recorded with the customer (null for a guest);
//   * GIFT_CARD_TENDER     — the gift-card amount, in minor units;
//   * LOYALTY_REDEMPTION   — the Mocha Beans of the chosen reward.
// What is available is the balance or limit MINUS every ACTIVE hold, read
// under the source row's lock, so two checkouts can never both be charged
// for the last redemption, Bean or gift-card cent. If anything cannot be
// reserved the whole transaction rolls back: no attempt, no saved checkout,
// no hold, and nothing is charged.
//
// A hold is CONSUMED, exactly once, in the order transaction (payment
// SUCCEEDED). It is RELEASED by the database itself, in the same statement
// that records the payment as DECLINED or FAILED (ABANDONED: never sent) —
// whichever code path does that — and never otherwise. It is kept while the
// payment is charging, awaiting confirmation or unknown, and while a paid
// order waits for review — never released because time passed. The
// database guard trigger refuses any other change.
//
// Locks are always taken in one order — Promotion, then GiftCard, then
// CustomerLoyaltyAccount — the same order the order transaction applies the
// redemptions in, so a reservation and a fulfilment can never deadlock.

export type HoldKind =
  'PROMOTION_REDEMPTION' | 'GIFT_CARD_TENDER' | 'LOYALTY_REDEMPTION';

// What a payment must reserve, from its server-validated checkout.
export interface HoldRequest {
  promotion: { promotionId: string; customerId: string | null } | null;
  giftCard: { giftCardId: string; currency: string; amount: number } | null;
  loyalty: { customerId: string; beanCost: number } | null;
}

type Db = Prisma.TransactionClient | PrismaService;

function unavailable(message: string): ConflictException {
  return new ConflictException({
    code: CHECKOUT_RESOURCE_UNAVAILABLE,
    message,
  });
}

// --- what is held ------------------------------------------------------------------

async function heldSum(
  db: Db,
  where: Prisma.FinancialHoldWhereInput,
  exceptAttemptId?: string,
): Promise<number> {
  const result = await db.financialHold.aggregate({
    _sum: { amount: true },
    where: {
      ...where,
      status: 'ACTIVE',
      ...(exceptAttemptId
        ? { NOT: { paymentAttemptId: exceptAttemptId } }
        : {}),
    },
  });
  return result._sum.amount ?? 0;
}

// Minor units of the card held by payments in progress.
export function heldOnGiftCard(
  db: Db,
  tenantId: string,
  giftCardId: string,
  exceptAttemptId?: string,
): Promise<number> {
  return heldSum(db, { tenantId, giftCardId }, exceptAttemptId);
}

// Mocha Beans of the account held by payments in progress.
export function heldOnLoyaltyAccount(
  db: Db,
  tenantId: string,
  loyaltyAccountId: string,
  exceptAttemptId?: string,
): Promise<number> {
  return heldSum(db, { tenantId, loyaltyAccountId }, exceptAttemptId);
}

// Redemptions of the promotion held by payments in progress: in total, and
// by this customer.
export async function heldOnPromotion(
  db: Db,
  tenantId: string,
  promotionId: string,
  customerId: string | null,
  exceptAttemptId?: string,
): Promise<{ total: number; customer: number }> {
  const total = await heldSum(db, { tenantId, promotionId }, exceptAttemptId);
  const customer =
    customerId === null
      ? 0
      : await heldSum(
          db,
          { tenantId, promotionId, customerId },
          exceptAttemptId,
        );
  return { total, customer };
}

// The most any one customer has used plus holds for this promotion: a
// per-customer limit can never be set below it.
export async function highestCustomerCommitment(
  tx: Prisma.TransactionClient,
  tenantId: string,
  promotionId: string,
): Promise<number> {
  const rows = await tx.$queryRaw<{ committed: number | null }[]>`
    SELECT max(used + held)::int AS committed FROM (
      SELECT c."customerId",
             coalesce(u."usedCount", 0) AS used,
             coalesce(h.held, 0) AS held
        FROM (
          SELECT "customerId" FROM "PromotionCustomerUsage"
           WHERE "tenantId" = ${tenantId} AND "promotionId" = ${promotionId}
          UNION
          SELECT "customerId" FROM "FinancialHold"
           WHERE "tenantId" = ${tenantId} AND "promotionId" = ${promotionId}
             AND status = 'ACTIVE' AND "customerId" IS NOT NULL
        ) c
        LEFT JOIN "PromotionCustomerUsage" u
          ON u."tenantId" = ${tenantId} AND u."promotionId" = ${promotionId}
         AND u."customerId" = c."customerId"
        LEFT JOIN (
          SELECT "customerId", count(*)::int AS held FROM "FinancialHold"
           WHERE "tenantId" = ${tenantId} AND "promotionId" = ${promotionId}
             AND status = 'ACTIVE'
           GROUP BY "customerId"
        ) h ON h."customerId" = c."customerId"
    ) per_customer`;
  return rows[0]?.committed ?? 0;
}

// --- reserving -------------------------------------------------------------------

// Reserves everything `request` needs for this payment attempt, in the
// caller's transaction (the one creating the attempt). Throws a 409
// CHECKOUT_RESOURCE_UNAVAILABLE — rolling the whole transaction back — when
// anything is no longer available.
export async function reserveFinancialHolds(
  tx: Prisma.TransactionClient,
  tenantId: string,
  paymentAttemptId: string,
  request: HoldRequest,
): Promise<void> {
  if (request.promotion) {
    await reservePromotion(tx, tenantId, paymentAttemptId, request.promotion);
  }
  if (request.giftCard) {
    await reserveGiftCard(tx, tenantId, paymentAttemptId, request.giftCard);
  }
  if (request.loyalty) {
    await reserveLoyalty(tx, tenantId, paymentAttemptId, request.loyalty);
  }
}

async function reservePromotion(
  tx: Prisma.TransactionClient,
  tenantId: string,
  paymentAttemptId: string,
  want: NonNullable<HoldRequest['promotion']>,
): Promise<void> {
  const [promotion] = await tx.$queryRaw<
    {
      redemptionCount: number;
      totalRedemptionLimit: number | null;
      perCustomerRedemptionLimit: number | null;
    }[]
  >`
    SELECT "redemptionCount", "totalRedemptionLimit", "perCustomerRedemptionLimit"
      FROM "Promotion"
     WHERE id = ${want.promotionId} AND "tenantId" = ${tenantId}
     FOR UPDATE`;
  if (!promotion) {
    throw unavailable(
      'This offer is no longer available. Nothing was charged — please review your order.',
    );
  }
  const held = await heldOnPromotion(
    tx,
    tenantId,
    want.promotionId,
    want.customerId,
    paymentAttemptId,
  );
  if (
    promotion.totalRedemptionLimit !== null &&
    promotion.redemptionCount + held.total >= promotion.totalRedemptionLimit
  ) {
    throw unavailable(
      'This offer has reached its redemption limit. Nothing was charged — please review your order.',
    );
  }
  if (promotion.perCustomerRedemptionLimit !== null) {
    // A per-customer limit needs a signed-in customer: a guest is never
    // identified by contact details instead.
    if (want.customerId === null) {
      throw unavailable('Sign in to use this offer. Nothing was charged.');
    }
    const usage = await tx.promotionCustomerUsage.findUnique({
      where: {
        promotionId_customerId: {
          promotionId: want.promotionId,
          customerId: want.customerId,
        },
      },
      select: { usedCount: true, tenantId: true },
    });
    const used = usage && usage.tenantId === tenantId ? usage.usedCount : 0;
    if (used + held.customer >= promotion.perCustomerRedemptionLimit) {
      throw unavailable(
        'You have already used this offer the maximum number of times. Nothing was charged.',
      );
    }
  }
  await tx.financialHold.create({
    data: {
      tenantId,
      paymentAttemptId,
      kind: 'PROMOTION_REDEMPTION',
      amount: 1,
      promotionId: want.promotionId,
      customerId: want.customerId,
    },
  });
}

async function reserveGiftCard(
  tx: Prisma.TransactionClient,
  tenantId: string,
  paymentAttemptId: string,
  want: NonNullable<HoldRequest['giftCard']>,
): Promise<void> {
  const [card] = await tx.$queryRaw<
    { status: string; currency: string; balanceMinorUnits: number }[]
  >`
    SELECT status::text AS status, currency, "balanceMinorUnits"
      FROM "GiftCard"
     WHERE id = ${want.giftCardId} AND "tenantId" = ${tenantId}
     FOR UPDATE`;
  if (!card || card.status !== 'ACTIVE' || card.currency !== want.currency) {
    throw unavailable(
      'That gift card can no longer be used. Nothing was charged — please review your order.',
    );
  }
  const held = await heldOnGiftCard(
    tx,
    tenantId,
    want.giftCardId,
    paymentAttemptId,
  );
  if (card.balanceMinorUnits - held < want.amount) {
    throw unavailable(
      'That gift card no longer has enough available balance. Nothing was charged — please review your order.',
    );
  }
  await tx.financialHold.create({
    data: {
      tenantId,
      paymentAttemptId,
      kind: 'GIFT_CARD_TENDER',
      amount: want.amount,
      giftCardId: want.giftCardId,
    },
  });
}

async function reserveLoyalty(
  tx: Prisma.TransactionClient,
  tenantId: string,
  paymentAttemptId: string,
  want: NonNullable<HoldRequest['loyalty']>,
): Promise<void> {
  const [account] = await tx.$queryRaw<{ id: string; balance: number }[]>`
    SELECT id, balance FROM "CustomerLoyaltyAccount"
     WHERE "customerId" = ${want.customerId} AND "tenantId" = ${tenantId}
     FOR UPDATE`;
  const held = account
    ? await heldOnLoyaltyAccount(tx, tenantId, account.id, paymentAttemptId)
    : 0;
  if (!account || account.balance - held < want.beanCost) {
    throw unavailable(
      'You no longer have enough available Mocha Beans for this reward. Nothing was charged — please review your order.',
    );
  }
  await tx.financialHold.create({
    data: {
      tenantId,
      paymentAttemptId,
      kind: 'LOYALTY_REDEMPTION',
      amount: want.beanCost,
      loyaltyAccountId: account.id,
    },
  });
}

// --- the order transaction ----------------------------------------------------------

// Before the order applies its redemptions: every hold this payment has must
// be ACTIVE and match exactly what the order applies; anything the order
// needs but this payment never reserved (a payment from before ESP-03 PR 8)
// is reserved now, against what others hold. Throws ConflictException — the
// order transaction rolls back and the payment is kept for review — on any
// mismatch or shortfall.
export async function prepareHoldsForOrder(
  tx: Prisma.TransactionClient,
  tenantId: string,
  paymentAttemptId: string,
  request: HoldRequest,
): Promise<void> {
  const holds = await tx.financialHold.findMany({
    where: { tenantId, paymentAttemptId },
  });
  const byKind = new Map(holds.map((h) => [h.kind as HoldKind, h]));
  const mismatch = () =>
    new ConflictException(
      `Payment succeeded but what it reserved does not match its order. ` +
        `Reference ${paymentAttemptId} for support.`,
    );
  for (const hold of holds) {
    if (hold.status !== 'ACTIVE') throw mismatch();
  }
  const missing: HoldRequest = {
    promotion: null,
    giftCard: null,
    loyalty: null,
  };

  const promotion = byKind.get('PROMOTION_REDEMPTION');
  if (promotion) {
    if (
      !request.promotion ||
      promotion.promotionId !== request.promotion.promotionId ||
      promotion.customerId !== request.promotion.customerId
    ) {
      throw mismatch();
    }
  } else {
    missing.promotion = request.promotion;
  }

  const giftCard = byKind.get('GIFT_CARD_TENDER');
  if (giftCard) {
    if (
      !request.giftCard ||
      giftCard.giftCardId !== request.giftCard.giftCardId ||
      giftCard.amount !== request.giftCard.amount
    ) {
      throw mismatch();
    }
  } else {
    missing.giftCard = request.giftCard;
  }

  const loyalty = byKind.get('LOYALTY_REDEMPTION');
  if (loyalty) {
    if (!request.loyalty || loyalty.amount !== request.loyalty.beanCost) {
      throw mismatch();
    }
    const account = await tx.customerLoyaltyAccount.findFirst({
      where: { tenantId, customerId: request.loyalty.customerId },
      select: { id: true },
    });
    if (!account || account.id !== loyalty.loyaltyAccountId) {
      throw mismatch();
    }
  } else {
    missing.loyalty = request.loyalty;
  }

  if (missing.promotion || missing.giftCard || missing.loyalty) {
    try {
      await reserveFinancialHolds(tx, tenantId, paymentAttemptId, missing);
    } catch (error) {
      if (error instanceof ConflictException) {
        throw new ConflictException(
          `Payment succeeded but what it pays for is no longer available. ` +
            `Reference ${paymentAttemptId} for support.`,
        );
      }
      throw error;
    }
  }
}

// After the order applied its redemptions, in the same transaction: every
// hold of this payment is consumed, exactly once.
export async function consumeHoldsForOrder(
  tx: Prisma.TransactionClient,
  tenantId: string,
  paymentAttemptId: string,
): Promise<void> {
  await tx.financialHold.updateMany({
    where: { tenantId, paymentAttemptId, status: 'ACTIVE' },
    data: { status: 'CONSUMED', consumedAt: new Date() },
  });
}
