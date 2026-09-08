import { ConflictException, Injectable } from '@nestjs/common';
import type {
  CouponQuoteStatus,
  LocationMenuResponse,
  PromotionDiscountType,
  PromotionKind,
} from '@mocha-house/contracts';
import {
  computeRegularDiscount,
  type PricingResult,
  type RegularDiscountApplicability,
  type RegularDiscountCartLine,
} from '@mocha-house/domain';
import type { Prisma } from '@mocha-house/database';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeCouponCode } from './coupon-code';

// Milestone 7E — the checkout-time resolution and application of the ONE
// regular Promotion or Coupon on an order. Separate from the admin CRUD
// service (PromotionsAdminService).
//
//   - resolveRegularDiscount: given the cart + optional coupon code, decide
//     which regular discount applies. A supplied coupon is validated
//     against every rule; if it fails, the reason is returned (never
//     silently swapped for an automatic Promotion). With no coupon, the
//     single automatic Promotion producing the highest monetary discount
//     is chosen (deterministic tie-break on createdAt, then id).
//   - applyRedemption: the commit-time write — the immutable
//     OrderPromotionRedemption snapshot plus the concurrency-safe
//     conditional increments of the total and per-customer redemption
//     counters, all on the caller's `tx`.
//
// The client only ever sends a code + cart. Every monetary value here is
// server-computed. This discount is applied BEFORE any Mocha Bean reward.

type PricedOk = Extract<PricingResult, { ok: true }>;

export interface RegularDiscountPlan {
  promotionId: string;
  name: string;
  kind: PromotionKind;
  couponCode: string | null;
  discountType: PromotionDiscountType;
  discountValue: number;
  discountMinorUnits: number;
  freeItem: { productId: string; productName: string } | null;
  totalRedemptionLimit: number | null;
  perCustomerRedemptionLimit: number | null;
}

export type RegularDiscountResolution =
  | { outcome: 'none' }
  | { outcome: 'applied'; plan: RegularDiscountPlan }
  | {
      outcome: 'coupon_rejected';
      status: Exclude<CouponQuoteStatus, 'applied'>;
      message: string;
    };

type PromotionRow = Prisma.PromotionGetPayload<{
  include: {
    eligibleProducts: { select: { productId: true } };
    eligibleCategories: { select: { categoryId: true } };
    eligibleLocations: { select: { locationId: true } };
  };
}>;

const PROMOTION_INCLUDE = {
  eligibleProducts: { select: { productId: true } },
  eligibleCategories: { select: { categoryId: true } },
  eligibleLocations: { select: { locationId: true } },
} satisfies Prisma.PromotionInclude;

@Injectable()
export class PromotionCheckoutService {
  constructor(private readonly prisma: PrismaService) {}

  // A `db` that is the ambient client pre-payment, or the transaction client
  // for the authoritative in-transaction revalidation.
  async resolveRegularDiscount(input: {
    db?: Prisma.TransactionClient;
    priced: PricedOk;
    menu: LocationMenuResponse;
    locationId: string;
    customerId: string | null;
    couponCode: string | null;
  }): Promise<RegularDiscountResolution> {
    const db = input.db ?? this.prisma;
    const now = new Date();
    const lines = this.toDiscountLines(input.priced, input.menu);

    const rawCode =
      typeof input.couponCode === 'string' && input.couponCode.trim().length > 0
        ? input.couponCode
        : null;

    if (rawCode !== null) {
      const normalized = normalizeCouponCode(rawCode);
      if (normalized === null) {
        return this.reject('invalid', "That coupon code isn't valid.");
      }
      const promotion = await db.promotion.findUnique({
        where: { code: normalized },
        include: PROMOTION_INCLUDE,
      });
      if (!promotion || promotion.kind !== 'COUPON') {
        return this.reject('invalid', "We couldn't find that coupon.");
      }
      if (!promotion.isActive) {
        return this.reject('inactive', 'That coupon is no longer active.');
      }
      if (promotion.startsAt !== null && promotion.startsAt > now) {
        return this.reject('not_started', "That coupon isn't available yet.");
      }
      if (promotion.endsAt !== null && promotion.endsAt <= now) {
        return this.reject('expired', 'That coupon has expired.');
      }
      if (!this.locationEligible(promotion, input.locationId)) {
        return this.reject(
          'wrong_location',
          "That coupon isn't valid at this location.",
        );
      }
      const discount = computeRegularDiscount({
        grossSubtotalMinorUnits: input.priced.subtotal,
        lines,
        config: this.toConfig(promotion),
      });
      if (!discount.ok) {
        return discount.code === 'MINIMUM_NOT_MET'
          ? this.reject(
              'minimum_not_met',
              'Your order doesn’t reach this coupon’s minimum.',
            )
          : this.reject(
              'not_applicable',
              "That coupon doesn't apply to anything in your cart.",
            );
      }
      if (
        promotion.perCustomerRedemptionLimit !== null &&
        input.customerId === null
      ) {
        return this.reject(
          'sign_in_required',
          'Sign in to use this coupon.',
        );
      }
      const limitStatus = await this.checkLimits(
        db,
        promotion,
        input.customerId,
      );
      if (limitStatus !== null) {
        return this.reject(
          'usage_limit_reached',
          'This coupon has reached its redemption limit.',
        );
      }
      return {
        outcome: 'applied',
        plan: this.toPlan(promotion, discount.discountMinorUnits, discount.freeItem),
      };
    }

    // No coupon — pick the best eligible automatic Promotion.
    const candidates = await db.promotion.findMany({
      where: {
        kind: 'AUTOMATIC',
        isActive: true,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
          {
            OR: [
              { appliesToAllLocations: true },
              { eligibleLocations: { some: { locationId: input.locationId } } },
            ],
          },
        ],
      },
      include: PROMOTION_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });

    let best: RegularDiscountPlan | null = null;
    for (const promotion of candidates) {
      // A guest cannot benefit from an automatic Promotion that has a
      // per-customer limit (it can't be tracked).
      if (
        promotion.perCustomerRedemptionLimit !== null &&
        input.customerId === null
      ) {
        continue;
      }
      const discount = computeRegularDiscount({
        grossSubtotalMinorUnits: input.priced.subtotal,
        lines,
        config: this.toConfig(promotion),
      });
      if (!discount.ok || discount.discountMinorUnits <= 0) {
        continue;
      }
      if ((await this.checkLimits(db, promotion, input.customerId)) !== null) {
        continue;
      }
      if (best === null || discount.discountMinorUnits > best.discountMinorUnits) {
        best = this.toPlan(
          promotion,
          discount.discountMinorUnits,
          discount.freeItem,
        );
      }
    }

    return best === null ? { outcome: 'none' } : { outcome: 'applied', plan: best };
  }

  // Commit-time write. MUST be called inside the order transaction. Writes
  // the immutable snapshot and enforces the redemption limits with
  // conditional increments (updateMany where count < limit) — never a
  // read-compare-write. Throws ConflictException (which the checkout flow
  // turns into reconciliationRequired) when a concurrent order won the last
  // available redemption.
  async applyRedemption(
    tx: Prisma.TransactionClient,
    input: { orderId: string; customerId: string | null; plan: RegularDiscountPlan },
  ): Promise<void> {
    const { orderId, customerId, plan } = input;

    // Total redemption limit — conditional increment.
    if (plan.totalRedemptionLimit !== null) {
      const res = await tx.promotion.updateMany({
        where: {
          id: plan.promotionId,
          redemptionCount: { lt: plan.totalRedemptionLimit },
        },
        data: { redemptionCount: { increment: 1 } },
      });
      if (res.count === 0) {
        throw new ConflictException(
          `This offer reached its redemption limit before your order could ` +
            `be completed. Reference ${orderId} for support.`,
        );
      }
    } else {
      await tx.promotion.updateMany({
        where: { id: plan.promotionId },
        data: { redemptionCount: { increment: 1 } },
      });
    }

    // Per-customer limit — conditional increment of the dedicated counter
    // row. Requires an authenticated customer (enforced upstream).
    const countsAgainstCustomerId =
      plan.perCustomerRedemptionLimit !== null ? customerId : null;
    if (plan.perCustomerRedemptionLimit !== null && customerId !== null) {
      await tx.promotionCustomerUsage.upsert({
        where: {
          promotionId_customerId: { promotionId: plan.promotionId, customerId },
        },
        create: { promotionId: plan.promotionId, customerId, usedCount: 0 },
        update: {},
      });
      const res = await tx.promotionCustomerUsage.updateMany({
        where: {
          promotionId: plan.promotionId,
          customerId,
          usedCount: { lt: plan.perCustomerRedemptionLimit },
        },
        data: { usedCount: { increment: 1 } },
      });
      if (res.count === 0) {
        throw new ConflictException(
          `You have already used this offer the maximum number of times. ` +
            `Reference ${orderId} for support.`,
        );
      }
    }

    await tx.orderPromotionRedemption.create({
      data: {
        orderId,
        sourcePromotionId: plan.promotionId,
        promotionName: plan.name,
        promotionKind: plan.kind,
        couponCode: plan.couponCode,
        discountType: plan.discountType,
        discountValue: plan.discountValue,
        discountMinorUnits: plan.discountMinorUnits,
        freeItemProductId: plan.freeItem?.productId ?? null,
        freeItemProductName: plan.freeItem?.productName ?? null,
        customerId: countsAgainstCustomerId,
      },
    });
  }

  // --- helpers ------------------------------------------------

  private reject(
    status: Exclude<CouponQuoteStatus, 'applied'>,
    message: string,
  ): RegularDiscountResolution {
    return { outcome: 'coupon_rejected', status, message };
  }

  private toPlan(
    promotion: PromotionRow,
    discountMinorUnits: number,
    freeItem: { productId: string; productName: string } | null,
  ): RegularDiscountPlan {
    return {
      promotionId: promotion.id,
      name: promotion.name,
      kind: promotion.kind,
      couponCode: promotion.kind === 'COUPON' ? promotion.code : null,
      discountType: promotion.discountType,
      discountValue: promotion.discountValue,
      discountMinorUnits,
      freeItem,
      totalRedemptionLimit: promotion.totalRedemptionLimit,
      perCustomerRedemptionLimit: promotion.perCustomerRedemptionLimit,
    };
  }

  private toConfig(promotion: PromotionRow) {
    return {
      discountType: promotion.discountType,
      discountValue: promotion.discountValue,
      maxDiscountMinorUnits: promotion.maxDiscountMinorUnits,
      applicability: promotion.applicability as RegularDiscountApplicability,
      eligibleProductIds: promotion.eligibleProducts.map((e) => e.productId),
      eligibleCategoryIds: promotion.eligibleCategories.map((e) => e.categoryId),
      minimumSubtotalMinorUnits: promotion.minimumSubtotalMinorUnits,
    };
  }

  private locationEligible(promotion: PromotionRow, locationId: string): boolean {
    return (
      promotion.appliesToAllLocations ||
      promotion.eligibleLocations.some((l) => l.locationId === locationId)
    );
  }

  // Returns a non-null marker string when a limit is (already) exhausted,
  // or null when there is capacity. This is the pre-check; the authoritative
  // enforcement is the conditional increment in applyRedemption.
  private async checkLimits(
    db: Prisma.TransactionClient | PrismaService,
    promotion: PromotionRow,
    customerId: string | null,
  ): Promise<string | null> {
    if (
      promotion.totalRedemptionLimit !== null &&
      promotion.redemptionCount >= promotion.totalRedemptionLimit
    ) {
      return 'total';
    }
    if (promotion.perCustomerRedemptionLimit !== null && customerId !== null) {
      const usage = await db.promotionCustomerUsage.findUnique({
        where: {
          promotionId_customerId: { promotionId: promotion.id, customerId },
        },
        select: { usedCount: true },
      });
      if (
        usage !== null &&
        usage.usedCount >= promotion.perCustomerRedemptionLimit
      ) {
        return 'per_customer';
      }
    }
    return null;
  }

  private toDiscountLines(
    priced: PricedOk,
    menu: LocationMenuResponse,
  ): RegularDiscountCartLine[] {
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
