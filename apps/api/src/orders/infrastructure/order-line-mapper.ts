import type {
  OrderLineSummary,
  OrderLoyaltyBonusSummary,
  OrderLoyaltyRewardSummary,
} from '@mocha-house/contracts';
import type { Prisma } from '@mocha-house/database';

// Shared by CheckoutService (confirmation/customer status) and
// AdminOrdersService (store queue) — both surface the same immutable
// OrderLine snapshot, just to different audiences.
export function toOrderLineSummary(line: {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  currency: string;
  selections: Prisma.JsonValue;
}): OrderLineSummary {
  const selections = Array.isArray(line.selections) ? line.selections : [];
  return {
    productId: line.productId,
    productName: line.productName,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    lineTotal: line.lineTotal,
    currency: line.currency,
    selections: selections.map((selection) => {
      const s = selection as { groupName: string; optionNames: string[] };
      return { groupName: s.groupName, optionNames: s.optionNames };
    }),
  };
}

// Milestone 7C — the immutable Mocha Bean redemption snapshot, projected
// for every order surface (confirmation, guest status, customer history,
// store detail). Null for an order with no reward. Every value comes from
// OrderLoyaltyRewardRedemption — never re-read from the live LoyaltyReward.
export function toOrderLoyaltyRewardSummary(
  redemption: {
    rewardName: string;
    rewardType: 'FIXED_AMOUNT' | 'FREE_ITEM';
    beanCost: number;
    discountMinorUnits: number;
    freeItemProductName: string | null;
  } | null,
): OrderLoyaltyRewardSummary | null {
  if (!redemption) {
    return null;
  }
  return {
    rewardName: redemption.rewardName,
    rewardType: redemption.rewardType,
    beanCost: redemption.beanCost,
    discountMinorUnits: redemption.discountMinorUnits,
    freeItemName: redemption.freeItemProductName,
  };
}

// Milestone 7D — the immutable bonus Mocha Beans snapshot, projected for
// every order surface. Null for an order that earned no bonus. Every value
// comes from OrderLoyaltyBonus / OrderLoyaltyBonusItem — never re-read from
// a live LoyaltyBonusPromotion.
export function toOrderLoyaltyBonusSummary(
  bonus: {
    totalBonusBeans: number;
    items: {
      promotionName: string;
      promotionType: 'EXTRA_BEANS' | 'MULTIPLIER';
      bonusValue: number;
      productName: string;
      qualifyingUnits: number;
      bonusBeans: number;
    }[];
  } | null,
): OrderLoyaltyBonusSummary | null {
  if (!bonus) {
    return null;
  }
  return {
    totalBonusBeans: bonus.totalBonusBeans,
    items: bonus.items.map((item) => ({
      promotionName: item.promotionName,
      promotionType: item.promotionType,
      bonusValue: item.bonusValue,
      productName: item.productName,
      qualifyingUnits: item.qualifyingUnits,
      bonusBeans: item.bonusBeans,
    })),
  };
}
