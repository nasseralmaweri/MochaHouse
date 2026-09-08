import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import type {
  CheckoutRewardOption,
  LocationMenuResponse,
} from '@mocha-house/contracts';
import {
  computeLoyaltyRewardDiscount,
  type PricingResult,
  type RewardDiscountCartLine,
} from '@mocha-house/domain';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';

// Milestone 7C — Mocha Bean reward redemption at checkout. This service
// owns everything about applying ONE reward to an order:
//   - previewForCart: the read-only "which rewards work for this cart"
//     quote the checkout UI shows (no mutation, no deduction).
//   - buildRedemptionPlan: authoritative validation of a chosen reward
//     against the current cart + CURRENT reward configuration. Called once
//     BEFORE payment (to size the charge) and again INSIDE the order
//     transaction (final validation). Never checks the balance.
//   - applyRedemption: the commit-time write — lock the loyalty account,
//     re-check the balance, and write the redemption snapshot + the REDEEM
//     ledger entry + the balance decrement, all on the caller's `tx`.
//
// The client only ever sends a reward id. Every number here is
// server-computed. Guests never reach this service (the checkout flow
// rejects a guest reward id before payment).

// A validated, ready-to-commit redemption. `discountMinorUnits` is what
// will be subtracted from the gross merchandise subtotal; `beanCost` is
// what will be deducted from the balance (always the reward's full cost).
export interface RedemptionPlan {
  rewardId: string;
  rewardName: string;
  rewardType: 'FIXED_AMOUNT' | 'FREE_ITEM';
  beanCost: number;
  discountMinorUnits: number;
  // FREE_ITEM only. `lineIndex` pins the freed unit to its exact priced
  // line so 7D bonus earning can exclude that same unit.
  freeItem: {
    productId: string;
    productName: string;
    lineIndex: number;
  } | null;
}

type PricedOk = Extract<PricingResult, { ok: true }>;

type RewardWithEligibility = {
  type: 'FIXED_AMOUNT' | 'FREE_ITEM';
  fixedAmountMinorUnits: number | null;
  eligibleProducts: { productId: string }[];
  eligibleCategories: { categoryId: string }[];
};

// Milestone 7E — a regular Promotion/Coupon discount is applied to the cart
// BEFORE the Mocha Bean reward. When one is in play, the reward is computed
// against the merchandise that remains: the FIXED_AMOUNT cap is the
// remaining amount, and a FREE_ITEM regular discount's freed unit (pinned
// to its exact priced line) is removed from the pool so the reward frees a
// genuinely different unit — or is found ineligible.
export interface RegularDiscountContext {
  merchandiseAfterRegularMinorUnits: number;
  regularFreeItemLineIndex: number | null;
}

@Injectable()
export class LoyaltyRedemptionService {
  constructor(private readonly prisma: PrismaService) {}

  // The checkout-time quote. Returns every ACTIVE reward that is eligible
  // for THIS cart, with the discount it would apply and whether the
  // customer can afford it right now.
  async previewForCart(
    customerId: string,
    priced: PricedOk,
    menu: LocationMenuResponse,
    regularContext?: RegularDiscountContext,
  ): Promise<{ balance: number; rewards: CheckoutRewardOption[] }> {
    const [account, rewards] = await Promise.all([
      this.prisma.customerLoyaltyAccount.findUnique({
        where: { customerId },
        select: { balance: true },
      }),
      this.prisma.loyaltyReward.findMany({
        where: { isActive: true },
        include: {
          eligibleProducts: { select: { productId: true } },
          eligibleCategories: { select: { categoryId: true } },
        },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const balance = account?.balance ?? 0;

    const options: CheckoutRewardOption[] = [];
    for (const reward of rewards) {
      const discount = this.computeRewardDiscount(
        reward,
        priced,
        menu,
        regularContext,
      );
      if (!discount.ok) {
        continue; // not eligible for this cart — hide it
      }
      options.push({
        rewardId: reward.id,
        name: reward.name,
        description: reward.description,
        type: reward.type,
        beanCost: reward.beanCost,
        discountMinorUnits: discount.discountMinorUnits,
        freeItemName: discount.freeItem?.productName ?? null,
        canAfford: balance >= reward.beanCost,
      });
    }
    return { balance, rewards: options };
  }

  // Authoritative validation of one chosen reward. Throws a 4xx for every
  // "cannot redeem" case EXCEPT an insufficient balance — the balance is
  // checked at commit time under a row lock (see applyRedemption), and also
  // as a pre-payment courtesy check by the caller.
  async buildRedemptionPlan(
    rewardId: unknown,
    priced: PricedOk,
    menu: LocationMenuResponse,
    regularContext?: RegularDiscountContext,
  ): Promise<RedemptionPlan> {
    if (typeof rewardId !== 'string' || rewardId.trim().length === 0) {
      throw new BadRequestException('A valid reward selection is required.');
    }

    const reward = await this.prisma.loyaltyReward.findUnique({
      where: { id: rewardId },
      include: {
        eligibleProducts: { select: { productId: true } },
        eligibleCategories: { select: { categoryId: true } },
      },
    });

    if (!reward) {
      throw new BadRequestException('That reward is not available.');
    }
    if (!reward.isActive) {
      throw new BadRequestException('That reward is no longer available.');
    }
    if (reward.type === 'FIXED_AMOUNT' && reward.fixedAmountMinorUnits === null) {
      // Structurally impossible under the 7B service, but never trust it.
      throw new ConflictException('That reward is misconfigured.');
    }

    const discount = this.computeRewardDiscount(
      reward,
      priced,
      menu,
      regularContext,
    );

    if (!discount.ok) {
      throw new BadRequestException(discount.message);
    }

    return {
      rewardId: reward.id,
      rewardName: reward.name,
      rewardType: reward.type,
      beanCost: reward.beanCost,
      discountMinorUnits: discount.discountMinorUnits,
      freeItem: discount.freeItem,
    };
  }

  // Commit-time write. MUST be called inside the same transaction that
  // creates the Order. Locks the loyalty account row (the 7A manual-adjust
  // pattern), re-reads the balance, and — only if enough Beans still
  // exist — writes the immutable redemption snapshot, the negative REDEEM
  // ledger entry, and the balance decrement. Throws ConflictException (which
  // the checkout flow turns into reconciliationRequired) if a concurrent
  // order consumed the Beans first.
  async applyRedemption(
    tx: Prisma.TransactionClient,
    input: { orderId: string; customerId: string; plan: RedemptionPlan },
  ): Promise<void> {
    const { orderId, customerId, plan } = input;

    const account = await tx.customerLoyaltyAccount.findUniqueOrThrow({
      where: { customerId },
      select: { id: true },
    });

    await tx.$queryRaw`SELECT id FROM "CustomerLoyaltyAccount" WHERE id = ${account.id} FOR UPDATE`;

    const locked = await tx.customerLoyaltyAccount.findUniqueOrThrow({
      where: { id: account.id },
      select: { balance: true },
    });

    if (locked.balance < plan.beanCost) {
      throw new ConflictException(
        `Not enough Mocha Beans to redeem this reward (balance ${locked.balance}, ` +
          `reward costs ${plan.beanCost}). Reference ${orderId} for support.`,
      );
    }

    await tx.orderLoyaltyRewardRedemption.create({
      data: {
        orderId,
        sourceRewardId: plan.rewardId,
        rewardName: plan.rewardName,
        rewardType: plan.rewardType,
        beanCost: plan.beanCost,
        discountMinorUnits: plan.discountMinorUnits,
        freeItemProductId: plan.freeItem?.productId ?? null,
        freeItemProductName: plan.freeItem?.productName ?? null,
      },
    });

    await tx.mochaBeanLedgerEntry.create({
      data: {
        loyaltyAccountId: account.id,
        type: 'REDEEM',
        amount: -plan.beanCost,
        orderId,
      },
    });

    await tx.customerLoyaltyAccount.update({
      where: { id: account.id },
      data: { balance: { decrement: plan.beanCost } },
    });
  }

  // The pure reward-discount computation, shared by previewForCart and
  // buildRedemptionPlan. When a regular Promotion/Coupon (Milestone 7E) has
  // already discounted the cart, `regularContext` supplies the remaining
  // merchandise ceiling and the unit it already freed.
  private computeRewardDiscount(
    reward: RewardWithEligibility,
    priced: PricedOk,
    menu: LocationMenuResponse,
    regularContext: RegularDiscountContext | undefined,
  ) {
    let lines = this.toDiscountLines(priced, menu);
    const merchandiseSubtotalMinorUnits =
      regularContext?.merchandiseAfterRegularMinorUnits ?? priced.subtotal;
    if (regularContext?.regularFreeItemLineIndex != null) {
      lines = decrementOneUnit(lines, regularContext.regularFreeItemLineIndex);
    }

    return computeLoyaltyRewardDiscount({
      merchandiseSubtotalMinorUnits,
      lines,
      reward:
        reward.type === 'FIXED_AMOUNT'
          ? {
              type: 'FIXED_AMOUNT',
              fixedAmountMinorUnits: reward.fixedAmountMinorUnits ?? 0,
            }
          : {
              type: 'FREE_ITEM',
              eligibleProductIds: reward.eligibleProducts.map((e) => e.productId),
              eligibleCategoryIds: reward.eligibleCategories.map(
                (e) => e.categoryId,
              ),
            },
    });
  }

  // priceCart lines -> the domain discount input. The category id per line
  // comes from the same effective menu priceCart used, so it is
  // authoritative and needs no extra DB read.
  private toDiscountLines(
    priced: PricedOk,
    menu: LocationMenuResponse,
  ): RewardDiscountCartLine[] {
    return priced.lines.map((line) => {
      const menuProduct = menu.menu.products.find(
        (p) => p.product.id === line.productId,
      );
      return {
        productId: line.productId,
        categoryId: menuProduct?.product.category.id ?? '',
        productName: line.productName,
        unitPriceMinorUnits: line.unitPrice,
        quantity: line.quantity,
      };
    });
  }
}

// Remove ONE unit from the priced line at `lineIndex` — the exact unit a
// regular FREE_ITEM Promotion/Coupon already freed. The line is KEPT (at
// quantity 0 if needed) so every other line's index stays stable;
// computeLoyaltyRewardDiscount ignores zero-quantity lines.
function decrementOneUnit(
  lines: RewardDiscountCartLine[],
  lineIndex: number,
): RewardDiscountCartLine[] {
  return lines.map((line, i) =>
    i === lineIndex
      ? { ...line, quantity: Math.max(0, line.quantity - 1) }
      : line,
  );
}
