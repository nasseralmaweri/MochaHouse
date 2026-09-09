import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import {
  canonicalizeGiftCardCode,
  hashGiftCardCode,
} from '../infrastructure/gift-card-code';

// Milestone 7G — gift-card redemption at checkout. This service owns
// everything about applying ONE gift card as tender to an order:
//   - resolveUsableCard: READ-ONLY resolution of a supplied code against the
//     current card state. Used by the checkout quote (to preview) and by
//     the checkout submission (to size the external charge, before any
//     payment). Reserves nothing, decrements nothing, never mutates.
//   - buildTenderPlan: turns a resolved card + the amount owed into a
//     validated, ready-to-commit plan (plannedTenderMinorUnits fixed here
//     and baked into PaymentAttempt.amount).
//   - applyRedemption: the commit-time write — lock the GiftCard row,
//     re-validate status / currency / balance, and write the
//     OrderGiftCardRedemption snapshot + the negative REDEMPTION ledger
//     entry + the materialized balance decrement, all on the caller's `tx`.
//
// A gift card is a TENDER, not a discount: it never changes the merchandise
// basis for promotion or Mocha Bean earning. The client only ever sends a
// code (in the request body); every number here is server-computed. Guests
// may redeem — a gift card is a bearer instrument. The plaintext code is
// canonicalized + HMAC-hashed (7F infra) and never stored / logged / echoed.

export type GiftCardResolution =
  | {
      outcome: 'usable';
      giftCardId: string;
      last4: string;
      balanceMinorUnits: number;
      currency: string;
    }
  | { outcome: 'not_found' }
  | { outcome: 'inactive'; last4: string }
  | { outcome: 'no_balance'; last4: string }
  | { outcome: 'currency_mismatch'; last4: string };

// A validated, ready-to-commit gift-card tender.
export interface GiftCardTenderPlan {
  giftCardId: string;
  last4: string;
  currency: string;
  // The exact tender to apply — min(balance at resolution, amount owed).
  // This value is baked into PaymentAttempt.amount (external charge = owed −
  // this) and is NEVER silently reduced afterwards: if the locked balance
  // can no longer satisfy it, the whole order transaction rolls back and
  // the successful payment is flagged reconciliationRequired.
  plannedTenderMinorUnits: number;
}

@Injectable()
export class GiftCardRedemptionService {
  constructor(private readonly prisma: PrismaService) {}

  // READ-ONLY. Canonicalize + hash the code, look the card up by codeHash,
  // and report whether it is usable for an order in `orderCurrency`. Never
  // reveals whether a code was malformed vs simply unknown (both →
  // not_found). No lock, no mutation.
  async resolveUsableCard(
    rawCode: unknown,
    orderCurrency: string,
  ): Promise<GiftCardResolution> {
    const canonical = canonicalizeGiftCardCode(rawCode);
    if (canonical === null) {
      return { outcome: 'not_found' };
    }

    const card = await this.prisma.giftCard.findUnique({
      where: { codeHash: hashGiftCardCode(canonical) },
      select: {
        id: true,
        last4: true,
        status: true,
        balanceMinorUnits: true,
        currency: true,
      },
    });
    if (!card) {
      return { outcome: 'not_found' };
    }
    if (card.status !== 'ACTIVE') {
      return { outcome: 'inactive', last4: card.last4 };
    }
    if (card.currency !== orderCurrency) {
      return { outcome: 'currency_mismatch', last4: card.last4 };
    }
    if (card.balanceMinorUnits <= 0) {
      return { outcome: 'no_balance', last4: card.last4 };
    }

    return {
      outcome: 'usable',
      giftCardId: card.id,
      last4: card.last4,
      balanceMinorUnits: card.balanceMinorUnits,
      currency: card.currency,
    };
  }

  // Checkout-submission path: resolve the supplied code and turn it into a
  // plan, throwing a customer-facing 4xx for every "cannot use this card"
  // case. Called BEFORE any PaymentAttempt exists. `amountOwedMinorUnits` is
  // the merchandise total after the regular Promotion/Coupon and the Mocha
  // Bean reward discounts.
  async buildTenderPlan(
    rawCode: unknown,
    amountOwedMinorUnits: number,
    orderCurrency: string,
  ): Promise<GiftCardTenderPlan> {
    const resolution = await this.resolveUsableCard(rawCode, orderCurrency);

    switch (resolution.outcome) {
      case 'not_found':
        throw new BadRequestException("We couldn't find that gift card.");
      case 'inactive':
        throw new BadRequestException(
          'That gift card is inactive and cannot be used.',
        );
      case 'currency_mismatch':
        throw new BadRequestException(
          "That gift card's currency doesn't match this order.",
        );
      case 'no_balance':
        throw new BadRequestException(
          'That gift card has no available balance.',
        );
      case 'usable':
        break;
    }

    if (amountOwedMinorUnits <= 0) {
      // The order is already fully covered by discounts — there is nothing
      // for the gift card to pay. Reject rather than silently ignore it, so
      // the customer can remove the card and continue.
      throw new BadRequestException(
        "Your order total is already covered — you don't need a gift card.",
      );
    }

    return {
      giftCardId: resolution.giftCardId,
      last4: resolution.last4,
      currency: resolution.currency,
      plannedTenderMinorUnits: Math.min(
        resolution.balanceMinorUnits,
        amountOwedMinorUnits,
      ),
    };
  }

  // Commit-time write. MUST be called inside the same transaction that
  // creates the Order. Locks the GiftCard row (the 7F admin-correction
  // pattern), re-validates status / currency, re-reads the authoritative
  // balance, and — only if it can still satisfy the EXACT planned tender —
  // writes the immutable OrderGiftCardRedemption snapshot, the negative
  // REDEMPTION ledger entry, and the materialized balance decrement. Throws
  // ConflictException (which the checkout flow turns into
  // reconciliationRequired) if the card can no longer cover the planned
  // tender or is no longer usable. The planned tender is NEVER reduced here.
  async applyRedemption(
    tx: Prisma.TransactionClient,
    input: { orderId: string; plan: GiftCardTenderPlan },
  ): Promise<void> {
    const { orderId, plan } = input;

    await tx.$queryRaw`SELECT id FROM "GiftCard" WHERE id = ${plan.giftCardId} FOR UPDATE`;

    const locked = await tx.giftCard.findUniqueOrThrow({
      where: { id: plan.giftCardId },
      select: { status: true, balanceMinorUnits: true, currency: true },
    });

    if (locked.status !== 'ACTIVE') {
      throw new ConflictException(
        `The gift card was deactivated before this order could be placed. ` +
          `Reference ${orderId} for support.`,
      );
    }
    if (locked.currency !== plan.currency) {
      throw new ConflictException(
        `The gift card's currency changed before this order could be placed. ` +
          `Reference ${orderId} for support.`,
      );
    }
    if (locked.balanceMinorUnits < plan.plannedTenderMinorUnits) {
      throw new ConflictException(
        `The gift card balance changed before this order could be placed ` +
          `(needed ${plan.plannedTenderMinorUnits}, had ${locked.balanceMinorUnits}). ` +
          `Reference ${orderId} for support.`,
      );
    }

    const balanceAfter =
      locked.balanceMinorUnits - plan.plannedTenderMinorUnits;

    await tx.orderGiftCardRedemption.create({
      data: {
        orderId,
        sourceGiftCardId: plan.giftCardId,
        last4: plan.last4,
        amountMinorUnits: plan.plannedTenderMinorUnits,
        currency: plan.currency,
      },
    });

    await tx.giftCardTransaction.create({
      data: {
        giftCardId: plan.giftCardId,
        type: 'REDEMPTION',
        amountMinorUnits: -plan.plannedTenderMinorUnits,
        balanceAfterMinorUnits: balanceAfter,
        orderId,
      },
    });

    await tx.giftCard.update({
      where: { id: plan.giftCardId },
      data: { balanceMinorUnits: { decrement: plan.plannedTenderMinorUnits } },
    });
  }
}
