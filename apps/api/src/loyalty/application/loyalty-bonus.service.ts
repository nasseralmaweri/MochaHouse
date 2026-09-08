import { Injectable } from '@nestjs/common';
import type { Prisma } from '@mocha-house/database';
import {
  DEFAULT_MOCHA_BEANS_PER_DOLLAR,
  computeOrderLoyaltyBonuses,
  type BonusCartLine,
  type BonusPromotionInput,
} from '@mocha-house/domain';
import { PrismaService } from '../../prisma/prisma.service';
import { LOYALTY_CONFIGURATION_KEY } from './loyalty.service';

// Milestone 7D — Bonus Mocha Beans Promotions, the ORDER-TIME earning path.
// Called by CheckoutService INSIDE the order-creation transaction, AFTER
// applyRedemption (7C) and earnForOrder (7A/7B), so:
//   - a guest order (no customerId) never reaches here;
//   - an order whose transaction rolls back earns no bonus;
//   - the Order, the OrderLoyaltyBonus snapshot, the single positive
//     BONUS_EARN ledger entry and the balance increment are all atomic.
//
// This never changes the standard EARN — the customer still earns standard
// Beans on the post-discount merchandise subtotal exactly as before. This
// only adds the promotional contribution. `@@unique([type, orderId])` on
// the ledger and `OrderLoyaltyBonus.orderId @unique` make BONUS_EARN and
// the snapshot exactly-once per order; this method is only ever called once
// per order creation.

export interface ApplyBonusForOrderInput {
  // The SAME transaction client creating the Order.
  tx: Prisma.TransactionClient;
  customerId: string;
  orderId: string;
  locationId: string;
  currency: string;
  // The authoritative repriced cart lines (from priceCart, inside the
  // transaction). unitPrice already includes modifier adjustments.
  pricedLines: {
    productId: string;
    productName: string;
    unitPrice: number;
    quantity: number;
  }[];
  // Milestone 7C interaction: the single unit made free by a FREE_ITEM
  // reward (null if none), and an order-level FIXED_AMOUNT reward discount
  // in minor units (0 if none). Bonus earning uses the qualifying spend
  // that actually remains after these.
  freeItemProductId: string | null;
  fixedRewardDiscountMinorUnits: number;
}

@Injectable()
export class LoyaltyBonusService {
  constructor(private readonly prisma: PrismaService) {}

  async applyBonusForOrder(input: ApplyBonusForOrderInput): Promise<void> {
    const {
      tx,
      customerId,
      orderId,
      locationId,
      currency,
      pricedLines,
      freeItemProductId,
      fixedRewardDiscountMinorUnits,
    } = input;

    // Bonus Beans are earned on USD merchandise only, mirroring earnForOrder.
    if (currency !== 'USD') {
      return;
    }

    const productIds = [...new Set(pricedLines.map((l) => l.productId))];
    if (productIds.length === 0) {
      return;
    }

    // CURRENT authoritative promotion state, evaluated at order time — a
    // promotion HQ deactivated, re-dated, or de-targeted before this
    // transaction finalises does not apply. The customer never reserves a
    // bonus merely by seeing it.
    const now = new Date();
    const promotions = await tx.loyaltyBonusPromotion.findMany({
      where: {
        isActive: true,
        eligibleProducts: { some: { productId: { in: productIds } } },
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
          {
            OR: [
              { appliesToAllLocations: true },
              { eligibleLocations: { some: { locationId } } },
            ],
          },
        ],
      },
      include: { eligibleProducts: { select: { productId: true } } },
      // Stable order so the domain's "first promotion wins a tie" rule is
      // deterministic.
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    if (promotions.length === 0) {
      return;
    }

    const config = await tx.loyaltyConfiguration.findUnique({
      where: { key: LOYALTY_CONFIGURATION_KEY },
      select: { earningRatePerDollar: true },
    });
    const standardRatePerDollar =
      config?.earningRatePerDollar ?? DEFAULT_MOCHA_BEANS_PER_DOLLAR;

    const lines: BonusCartLine[] = pricedLines.map((line) => ({
      productId: line.productId,
      productName: line.productName,
      unitPriceMinorUnits: line.unitPrice,
      quantity: line.quantity,
    }));

    const promotionInputs: BonusPromotionInput[] = promotions.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      bonusValue: p.bonusValue,
      eligibleProductIds: p.eligibleProducts.map((e) => e.productId),
    }));

    const result = computeOrderLoyaltyBonuses({
      lines,
      standardRatePerDollar,
      freeItemProductId,
      fixedRewardDiscountMinorUnits,
      promotions: promotionInputs,
    });

    if (result.totalBonusBeans <= 0) {
      return;
    }

    const account = await tx.customerLoyaltyAccount.findUniqueOrThrow({
      where: { customerId },
      select: { id: true },
    });

    await tx.orderLoyaltyBonus.create({
      data: {
        orderId,
        totalBonusBeans: result.totalBonusBeans,
        items: {
          create: result.items.map((item) => ({
            sourcePromotionId: item.sourcePromotionId,
            promotionName: item.promotionName,
            promotionType: item.promotionType,
            bonusValue: item.bonusValue,
            productId: item.productId,
            productName: item.productName,
            qualifyingUnits: item.qualifyingUnits,
            qualifyingSpendMinorUnits: item.qualifyingSpendMinorUnits,
            standardBeansForItem: item.standardBeansForItem,
            bonusBeans: item.bonusBeans,
          })),
        },
      },
    });

    await tx.mochaBeanLedgerEntry.create({
      data: {
        loyaltyAccountId: account.id,
        type: 'BONUS_EARN',
        amount: result.totalBonusBeans,
        orderId,
      },
    });

    await tx.customerLoyaltyAccount.update({
      where: { id: account.id },
      data: { balance: { increment: result.totalBonusBeans } },
    });
  }
}
