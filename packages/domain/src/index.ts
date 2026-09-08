import type {
  CheckoutLineInput,
  LocationMenuResponse,
  OrderLineSummary,
  OrderStatus,
  ReorderIssue,
  ReorderItemStatus,
  ReorderPreparedItem,
  ReorderPreparationStatus,
} from "@mocha-house/contracts";

// The one place the approved operational pipeline (RECEIVED -> ACCEPTED ->
// PREPARING -> READY -> COMPLETED) is encoded. Deliberately a strict
// single-step "what's next" function rather than a general "is X -> Y
// legal" validator — the store API never accepts an arbitrary target
// status, only "advance", so there is no transition request this function
// could be asked to validate as invalid in the first place.
const NEXT_ORDER_STATUS: Record<OrderStatus, OrderStatus | null> = {
  RECEIVED: "ACCEPTED",
  ACCEPTED: "PREPARING",
  PREPARING: "READY",
  READY: "COMPLETED",
  COMPLETED: null,
};

// Returns the next status in the pipeline, or null if `current` is
// terminal (COMPLETED) and cannot be advanced further.
export function nextOrderStatus(current: OrderStatus): OrderStatus | null {
  return NEXT_ORDER_STATUS[current];
}

export function isActiveOrderStatus(status: OrderStatus): boolean {
  return status !== "COMPLETED";
}

// Pure, framework-agnostic repricing/validation for a submitted cart against
// an already-fetched effective menu. This is the one place "is this cart
// still valid, and what does it actually cost" gets decided — the browser
// cart's cached prices and availability flags are never trusted, only
// re-derived here from the live menu passed in by the caller.
//
// All money is integer minor units (cents). No tax/fee model is applied —
// `subtotal` is the full merchandise total for this slice.

export type PricingErrorCode =
  | "LOCATION_INACTIVE"
  | "DIGITAL_ORDERING_DISABLED"
  | "EMPTY_CART"
  | "INVALID_QUANTITY"
  | "PRODUCT_NOT_ON_MENU"
  | "PRODUCT_UNAVAILABLE"
  | "MODIFIER_GROUP_NOT_FOUND"
  | "MODIFIER_SELECTION_COUNT_INVALID"
  | "MODIFIER_OPTION_NOT_FOUND"
  | "CURRENCY_MISMATCH";

export interface PricingError {
  code: PricingErrorCode;
  message: string;
  productId?: string;
  groupId?: string;
}

export interface PricedLine extends OrderLineSummary {
  productId: string;
  selectionSnapshots: {
    groupId: string;
    groupName: string;
    optionIds: string[];
    optionNames: string[];
  }[];
}

export type PricingResult =
  | { ok: true; currency: string; subtotal: number; lines: PricedLine[] }
  | { ok: false; error: PricingError };

const MAX_LINE_QUANTITY = 20;

export function priceCart(
  menu: LocationMenuResponse,
  lines: CheckoutLineInput[],
): PricingResult {
  if (!menu.location.isDigitalOrderingEnabled) {
    return {
      ok: false,
      error: {
        code: "DIGITAL_ORDERING_DISABLED",
        message: "Online ordering is not available at this location.",
      },
    };
  }

  if (lines.length === 0) {
    return {
      ok: false,
      error: { code: "EMPTY_CART", message: "Cart is empty." },
    };
  }

  const pricedLines: PricedLine[] = [];
  let currency: string | null = null;

  for (const line of lines) {
    if (
      !Number.isInteger(line.quantity) ||
      line.quantity < 1 ||
      line.quantity > MAX_LINE_QUANTITY
    ) {
      return {
        ok: false,
        error: {
          code: "INVALID_QUANTITY",
          message: `Quantity must be between 1 and ${MAX_LINE_QUANTITY}.`,
          productId: line.productId,
        },
      };
    }

    const menuProduct = menu.menu.products.find(
      (candidate) => candidate.product.id === line.productId,
    );

    if (!menuProduct) {
      return {
        ok: false,
        error: {
          code: "PRODUCT_NOT_ON_MENU",
          message: "One of the items in your cart is no longer on the menu.",
          productId: line.productId,
        },
      };
    }

    if (!menuProduct.isAvailable || menuProduct.effectivePrice === null) {
      return {
        ok: false,
        error: {
          code: "PRODUCT_UNAVAILABLE",
          message: `${menuProduct.product.name} is currently unavailable.`,
          productId: line.productId,
        },
      };
    }

    if (currency === null) {
      currency = menuProduct.product.currency;
    } else if (currency !== menuProduct.product.currency) {
      return {
        ok: false,
        error: {
          code: "CURRENCY_MISMATCH",
          message: "Cart items do not share a common currency.",
          productId: line.productId,
        },
      };
    }

    let unitPrice = menuProduct.effectivePrice;
    const selectionSnapshots: PricedLine["selectionSnapshots"] = [];

    for (const group of menuProduct.modifierGroups) {
      const selection = line.selections.find((s) => s.groupId === group.id);
      const optionIds = [...new Set(selection?.optionIds ?? [])];
      const count = optionIds.length;

      if (group.isRequired && count === 0) {
        return {
          ok: false,
          error: {
            code: "MODIFIER_SELECTION_COUNT_INVALID",
            message: `${group.name} requires a selection.`,
            productId: line.productId,
            groupId: group.id,
          },
        };
      }

      if (
        count < group.minSelections ||
        (group.maxSelections !== null && count > group.maxSelections)
      ) {
        return {
          ok: false,
          error: {
            code: "MODIFIER_SELECTION_COUNT_INVALID",
            message: `${group.name} selection count is invalid.`,
            productId: line.productId,
            groupId: group.id,
          },
        };
      }

      const optionNames: string[] = [];
      for (const optionId of optionIds) {
        const option = group.options.find((o) => o.id === optionId);
        if (!option) {
          return {
            ok: false,
            error: {
              code: "MODIFIER_OPTION_NOT_FOUND",
              message: `A selected option for ${group.name} is no longer available.`,
              productId: line.productId,
              groupId: group.id,
            },
          };
        }
        unitPrice += option.priceAdjustment;
        optionNames.push(option.name);
      }

      if (count > 0) {
        selectionSnapshots.push({
          groupId: group.id,
          groupName: group.name,
          optionIds,
          optionNames,
        });
      }
    }

    // Any submitted group that no longer exists on the product is silently
    // ignored above (the loop only iterates the product's current groups) —
    // that's intentional: a stale groupId that vanished from the menu can't
    // be priced, and PRODUCT_UNAVAILABLE-style hard failures are reserved
    // for the checks above. A submitted groupId with options that *don't*
    // resolve on a *current* group is caught by MODIFIER_OPTION_NOT_FOUND.

    const lineTotal = unitPrice * line.quantity;

    pricedLines.push({
      productId: line.productId,
      productName: menuProduct.product.name,
      quantity: line.quantity,
      unitPrice,
      lineTotal,
      currency: menuProduct.product.currency,
      selections: selectionSnapshots.map((s) => ({
        groupName: s.groupName,
        optionNames: s.optionNames,
      })),
      selectionSnapshots,
    });
  }

  const subtotal = pricedLines.reduce((sum, line) => sum + line.lineTotal, 0);

  return { ok: true, currency: currency as string, subtotal, lines: pricedLines };
}

// --- Reorder preparation (Milestone 4G) -------------------------------
// Pure, framework-agnostic validation of a historical order's line
// snapshots against an already-fetched current effective menu. Same
// authority boundary as priceCart: the historical prices/availability are
// never trusted, only the live menu passed in. Unlike priceCart this does
// NOT fail fast — it classifies every line so the customer can see the
// full picture, and it never substitutes a product or a modifier option.
//
// Matching is by STABLE ID only (OrderLine.productId, and the groupId /
// optionIds persisted in OrderLine.selections). Historical display names
// are used only for messages, never for matching.

export interface HistoricalReorderSelection {
  groupId: string;
  groupName: string;
  optionIds: string[];
  optionNames: string[];
}

export interface HistoricalReorderLine {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  currency: string;
  selections: HistoricalReorderSelection[];
}

export interface ReorderPreparationResult {
  status: ReorderPreparationStatus;
  items: ReorderPreparedItem[];
  currentEstimatedSubtotal: number;
}

// Any real (non-rounding) unit-price movement is worth showing. There is
// no rounding in this codebase's integer-cent math, so the threshold is 0
// — kept as a named constant to make the intent explicit.
const PRICE_CHANGE_MIN_CENTS = 1;

export function prepareReorder(
  menu: LocationMenuResponse,
  historicalLines: HistoricalReorderLine[],
): ReorderPreparationResult {
  const items: ReorderPreparedItem[] = [];

  for (const line of historicalLines) {
    items.push(prepareLine(menu, line));
  }

  const restorable = items.filter((item) => item.status !== "UNAVAILABLE");
  const currentEstimatedSubtotal = restorable.reduce(
    (sum, item) => sum + (item.currentLineSubtotal ?? 0),
    0,
  );

  let status: ReorderPreparationStatus;
  if (restorable.length === 0) {
    status = "UNAVAILABLE";
  } else if (items.every((item) => item.status === "VALID")) {
    status = "READY";
  } else {
    status = "NEEDS_REVIEW";
  }

  return { status, items, currentEstimatedSubtotal };
}

function prepareLine(
  menu: LocationMenuResponse,
  line: HistoricalReorderLine,
): ReorderPreparedItem {
  const menuProduct = menu.menu.products.find(
    (candidate) => candidate.product.id === line.productId,
  );

  const base = {
    productId: line.productId,
    quantity: line.quantity,
    currency: line.currency,
    historicalUnitPrice: line.unitPrice,
  };

  if (!menuProduct) {
    return {
      ...base,
      status: "UNAVAILABLE",
      productName: line.productName,
      selections: [],
      needsCustomization: false,
      issues: [
        {
          code: "PRODUCT_NOT_ON_MENU",
          message: `${line.productName} is no longer on this location's menu.`,
          productName: line.productName,
        },
      ],
    };
  }

  const currentName = menuProduct.product.name;

  if (!menuProduct.isAvailable || menuProduct.effectivePrice === null) {
    return {
      ...base,
      status: "UNAVAILABLE",
      productName: currentName,
      selections: [],
      needsCustomization: false,
      issues: [
        {
          code: "PRODUCT_UNAVAILABLE",
          message: `${currentName} is currently unavailable at this location.`,
          productName: currentName,
        },
      ],
    };
  }

  const issues: ReorderIssue[] = [];
  let needsCustomization = false;
  let unitPrice = menuProduct.effectivePrice;
  const resolvedSelections: ReorderPreparedItem["selections"] = [];

  // Track, per current group, how many options ended up selected — so
  // min/max and required rules can be checked against the CURRENT
  // structure afterward, not just the historical selections.
  const selectedCountByGroup = new Map<string, number>();

  for (const historicalSelection of line.selections) {
    const currentGroup = menuProduct.modifierGroups.find(
      (group) => group.id === historicalSelection.groupId,
    );

    if (!currentGroup) {
      issues.push({
        code: "MODIFIER_GROUP_REMOVED",
        message: `"${historicalSelection.groupName}" is no longer an option for ${currentName}.`,
        productName: currentName,
      });
      continue;
    }

    const resolvedOptionIds: string[] = [];
    const resolvedOptionNames: string[] = [];

    for (let i = 0; i < historicalSelection.optionIds.length; i++) {
      const optionId = historicalSelection.optionIds[i];
      const currentOption = currentGroup.options.find(
        (option) => option.id === optionId,
      );

      if (!currentOption) {
        const historicalOptionName =
          historicalSelection.optionNames[i] ?? "A previous choice";
        issues.push({
          code: "MODIFIER_OPTION_REMOVED",
          message: `${historicalOptionName} is no longer available for ${currentName}.`,
          productName: currentName,
        });
        continue;
      }

      resolvedOptionIds.push(currentOption.id);
      resolvedOptionNames.push(currentOption.name);
      unitPrice += currentOption.priceAdjustment;
    }

    selectedCountByGroup.set(currentGroup.id, resolvedOptionIds.length);

    if (resolvedOptionIds.length > 0) {
      resolvedSelections.push({
        groupId: currentGroup.id,
        groupName: currentGroup.name,
        optionIds: resolvedOptionIds,
        optionNames: resolvedOptionNames,
      });
    }
  }

  // Validate every CURRENT group's rules against what we ended up with —
  // this is where a newly-required group, or a min/max the historical
  // selection no longer satisfies, is caught. Never auto-picks a default.
  for (const group of menuProduct.modifierGroups) {
    const count = selectedCountByGroup.get(group.id) ?? 0;

    if (group.isRequired && count === 0) {
      needsCustomization = true;
      issues.push({
        code: "MODIFIER_REQUIRED_SELECTION_MISSING",
        message: `${currentName} now needs a "${group.name}" choice.`,
        productName: currentName,
      });
      continue;
    }

    if (
      count < group.minSelections ||
      (group.maxSelections !== null && count > group.maxSelections)
    ) {
      needsCustomization = true;
      issues.push({
        code: "MODIFIER_SELECTION_COUNT_INVALID",
        message: `Your "${group.name}" choice for ${currentName} needs updating.`,
        productName: currentName,
      });
    }
  }

  if (Math.abs(unitPrice - line.unitPrice) >= PRICE_CHANGE_MIN_CENTS) {
    issues.push({
      code: "PRICE_CHANGED",
      message: `The price of ${currentName} has changed since your last order.`,
      productName: currentName,
    });
  }

  const status: ReorderItemStatus = issues.length === 0 ? "VALID" : "CHANGED";
  const currentLineSubtotal = unitPrice * line.quantity;

  return {
    ...base,
    status,
    productName: currentName,
    currentUnitPrice: unitPrice,
    currentLineSubtotal,
    selections: resolvedSelections,
    needsCustomization,
    issues,
  };
}

// --- Mocha Beans earning (Milestone 7A; rate configurable in 7B) -----
// The one place the earning rate is applied. Qualifying spend is the
// merchandise subtotal in integer minor units (cents); the platform has no
// discount/tax/tip/fee/gift-card model yet, so Order.subtotal IS the
// qualifying spend today.
//
// `ratePerDollar` is the whole number of Mocha Beans awarded per whole
// qualifying dollar. Milestone 7B makes it HQ-configurable and persisted;
// the caller (LoyaltyService) loads the current company-wide rate and
// passes it in — this function stays pure and never touches a database.
// It defaults to DEFAULT_MOCHA_BEANS_PER_DOLLAR so a caller that has no
// configuration (a fresh install, a unit test) still gets the 7A behaviour.
//
// Whole qualifying DOLLARS only, truncated (never rounded). With rate 1:
//   $0.99  -> 0     $1.00  -> 1     $8.75  -> 8     $12.00 -> 12
// With rate 2:
//   $8.75  -> 8 whole dollars -> 16 Beans
export const DEFAULT_MOCHA_BEANS_PER_DOLLAR = 1;

// Backwards-compatible alias for the 7A constant name.
export const MOCHA_BEANS_PER_DOLLAR = DEFAULT_MOCHA_BEANS_PER_DOLLAR;

export function mochaBeansForQualifyingSpend(
  subtotalMinorUnits: number,
  ratePerDollar: number = DEFAULT_MOCHA_BEANS_PER_DOLLAR,
): number {
  if (
    !Number.isFinite(subtotalMinorUnits) ||
    !Number.isInteger(subtotalMinorUnits) ||
    subtotalMinorUnits <= 0
  ) {
    return 0;
  }
  // A malformed rate never earns and never throws — the service validates
  // the rate on write, this is the last line of defence for the earn path.
  if (
    !Number.isFinite(ratePerDollar) ||
    !Number.isInteger(ratePerDollar) ||
    ratePerDollar <= 0
  ) {
    return 0;
  }
  const wholeDollars = Math.floor(subtotalMinorUnits / 100);
  return wholeDollars * ratePerDollar;
}

// --- Mocha Bean reward discount (Milestone 7C) ----------------------
// Pure, framework-agnostic computation of the discount a single Mocha Bean
// reward applies to a cart. Never touches a database. The caller
// (LoyaltyRedemptionService) loads the CURRENT reward configuration and the
// authoritative repriced cart and passes both in; the server recomputes
// this at final validation time, never trusting a client-submitted value.
//
// All money is integer minor units. `unitPriceMinorUnits` is the fully
// resolved per-unit price INCLUDING modifier price adjustments, exactly as
// priceCart produces it — modifiers are already part of the unit price, so
// a free unit is the whole unit.

export interface RewardDiscountCartLine {
  productId: string;
  categoryId: string;
  productName: string;
  unitPriceMinorUnits: number;
  quantity: number;
}

export type RewardDiscountReward =
  | { type: "FIXED_AMOUNT"; fixedAmountMinorUnits: number }
  | {
      type: "FREE_ITEM";
      eligibleProductIds: string[];
      eligibleCategoryIds: string[];
    };

export interface RewardDiscountInput {
  // Gross merchandise subtotal (sum of every line total). The FIXED_AMOUNT
  // discount is capped at this — a reward never reduces merchandise below $0
  // and never creates cash value.
  merchandiseSubtotalMinorUnits: number;
  lines: RewardDiscountCartLine[];
  reward: RewardDiscountReward;
}

export type RewardDiscountResult =
  | {
      ok: true;
      discountMinorUnits: number;
      // The single freed unit (FREE_ITEM only); null for FIXED_AMOUNT.
      // `lineIndex` is the 0-based index into the `lines` array that was
      // passed in — the exact priced line the freed unit belongs to, so a
      // caller can exclude that specific unit (Milestone 7E: a regular
      // FREE_ITEM Promotion and a FREE_ITEM reward on the same product that
      // appears on multiple priced lines must free different units).
      freeItem: {
        productId: string;
        productName: string;
        lineIndex: number;
      } | null;
    }
  | { ok: false; code: "REWARD_NOT_ELIGIBLE"; message: string };

export function computeLoyaltyRewardDiscount(
  input: RewardDiscountInput,
): RewardDiscountResult {
  const gross = Math.max(0, input.merchandiseSubtotalMinorUnits);

  if (input.reward.type === "FIXED_AMOUNT") {
    const value = Math.max(0, input.reward.fixedAmountMinorUnits);
    // Capped at the eligible merchandise amount — never below $0.
    return { ok: true, discountMinorUnits: Math.min(value, gross), freeItem: null };
  }

  const eligibleProductIds = new Set(input.reward.eligibleProductIds);
  const eligibleCategoryIds = new Set(input.reward.eligibleCategoryIds);

  // Keep the original index so the freed unit can be pinned to its exact
  // priced line. A line already reduced to quantity 0 (a unit freed by a
  // regular Promotion — Milestone 7E) is not an eligible candidate.
  const eligibleLines = input.lines
    .map((line, lineIndex) => ({ line, lineIndex }))
    .filter(
      ({ line }) =>
        line.quantity > 0 &&
        (eligibleProductIds.has(line.productId) ||
          eligibleCategoryIds.has(line.categoryId)),
    );

  if (eligibleLines.length === 0) {
    return {
      ok: false,
      code: "REWARD_NOT_ELIGIBLE",
      message: "Your cart has no item eligible for this reward.",
    };
  }

  // Approved default: the LOWEST-PRICED eligible unit is free. Deterministic
  // tie-break on productId, then line index, so two carts with the same
  // prices always resolve the same freed unit.
  const chosen = eligibleLines.reduce((best, cur) => {
    if (cur.line.unitPriceMinorUnits < best.line.unitPriceMinorUnits) {
      return cur;
    }
    if (cur.line.unitPriceMinorUnits === best.line.unitPriceMinorUnits) {
      if (cur.line.productId < best.line.productId) {
        return cur;
      }
      if (
        cur.line.productId === best.line.productId &&
        cur.lineIndex < best.lineIndex
      ) {
        return cur;
      }
    }
    return best;
  });

  // One UNIT is free, not the whole line — quantity > 1 keeps the rest paid.
  const discount = Math.max(0, Math.min(chosen.line.unitPriceMinorUnits, gross));
  return {
    ok: true,
    discountMinorUnits: discount,
    freeItem: {
      productId: chosen.line.productId,
      productName: chosen.line.productName,
      lineIndex: chosen.lineIndex,
    },
  };
}

// --- Regular Promotion / Coupon discount (Milestone 7E) -----------
// Pure, framework-agnostic computation of the discount ONE regular
// Promotion or Coupon applies to a cart. Never touches a database. The
// caller (PromotionCheckoutService) loads the CURRENT promotion config and
// the authoritative repriced cart and passes both in; the server recomputes
// this at final validation time, never trusting a client-submitted value.
//
// This is the FIRST discount applied — a Mocha Bean reward (7C) is then
// applied to whatever merchandise remains. Deliberately bounded: three
// discount types, three applicability modes. No BOGO, tiers, formulas.
//
// All money is integer minor units. `unitPriceMinorUnits` is the fully
// resolved per-unit price INCLUDING modifier adjustments, exactly as
// priceCart produces it.

export type RegularDiscountType =
  | "PERCENTAGE_OFF"
  | "FIXED_AMOUNT"
  | "FREE_ITEM";

export type RegularDiscountApplicability =
  | "ENTIRE_ORDER"
  | "SELECTED_PRODUCTS"
  | "SELECTED_CATEGORIES";

export interface RegularDiscountCartLine {
  productId: string;
  categoryId: string;
  productName: string;
  unitPriceMinorUnits: number;
  quantity: number;
}

export interface RegularDiscountConfig {
  discountType: RegularDiscountType;
  // PERCENTAGE_OFF: whole percent 1..100. FIXED_AMOUNT: minor units > 0.
  // FREE_ITEM: ignored.
  discountValue: number;
  // PERCENTAGE_OFF only — optional cap on the resulting discount.
  maxDiscountMinorUnits: number | null;
  applicability: RegularDiscountApplicability;
  eligibleProductIds: string[];
  eligibleCategoryIds: string[];
  // Optional minimum GROSS merchandise subtotal, checked BEFORE this
  // discount (and before any Mocha Bean reward).
  minimumSubtotalMinorUnits: number | null;
}

export interface RegularDiscountInput {
  grossSubtotalMinorUnits: number;
  lines: RegularDiscountCartLine[];
  config: RegularDiscountConfig;
}

export type RegularDiscountResult =
  | {
      ok: true;
      discountMinorUnits: number;
      // The single freed unit (FREE_ITEM only); null otherwise. `lineIndex`
      // pins it to its exact priced line.
      freeItem: {
        productId: string;
        productName: string;
        lineIndex: number;
      } | null;
      // The distinct product ids the monetary discount was actually applied
      // to — `null` for ENTIRE_ORDER (and always for FREE_ITEM). Used so a
      // 7D bonus on an UNRELATED product is not computed on a reduced
      // qualifying spend: a targeted percentage/fixed discount is allocated
      // only across these products' lines.
      discountEligibleProductIds: string[] | null;
    }
  | {
      ok: false;
      code: "MINIMUM_NOT_MET" | "NOT_APPLICABLE";
      message: string;
    };

export function computeRegularDiscount(
  input: RegularDiscountInput,
): RegularDiscountResult {
  const gross = Math.max(0, Math.floor(input.grossSubtotalMinorUnits));
  const { config } = input;

  // Minimum purchase is measured on the GROSS subtotal, before this
  // discount and before any Mocha Bean reward.
  if (
    config.minimumSubtotalMinorUnits !== null &&
    gross < Math.max(0, config.minimumSubtotalMinorUnits)
  ) {
    return {
      ok: false,
      code: "MINIMUM_NOT_MET",
      message: "Your order doesn't reach this offer's minimum.",
    };
  }

  const eligibleProductIds = new Set(config.eligibleProductIds);
  const eligibleCategoryIds = new Set(config.eligibleCategoryIds);
  // Keep original indices so a FREE_ITEM freed unit can be pinned to its
  // exact priced line.
  const eligibleLines = input.lines
    .map((line, lineIndex) => ({ line, lineIndex }))
    .filter(({ line }) =>
      config.applicability === "ENTIRE_ORDER"
        ? true
        : config.applicability === "SELECTED_PRODUCTS"
          ? eligibleProductIds.has(line.productId)
          : eligibleCategoryIds.has(line.categoryId),
    );

  if (eligibleLines.length === 0) {
    return {
      ok: false,
      code: "NOT_APPLICABLE",
      message: "This offer doesn't apply to anything in your cart.",
    };
  }

  const eligibleGross = eligibleLines.reduce(
    (sum, { line }) =>
      sum + Math.max(0, line.unitPriceMinorUnits) * Math.max(0, line.quantity),
    0,
  );

  // The products the monetary discount actually applies to (null =
  // whole-order allocation). Never used for FREE_ITEM (which returns
  // explicit free units instead of a monetary bucket).
  const discountEligibleProductIds =
    config.applicability === "ENTIRE_ORDER"
      ? null
      : [...new Set(eligibleLines.map(({ line }) => line.productId))];

  if (config.discountType === "FREE_ITEM") {
    // The LOWEST-PRICED eligible unit is free — mirrors the 7C reward.
    // Deterministic tie-break on productId, then line index.
    const paidEligible = eligibleLines.filter(({ line }) => line.quantity > 0);
    if (paidEligible.length === 0) {
      return {
        ok: false,
        code: "NOT_APPLICABLE",
        message: "This offer doesn't apply to anything in your cart.",
      };
    }
    const chosen = paidEligible.reduce((best, cur) => {
        if (cur.line.unitPriceMinorUnits < best.line.unitPriceMinorUnits) {
          return cur;
        }
        if (cur.line.unitPriceMinorUnits === best.line.unitPriceMinorUnits) {
          if (cur.line.productId < best.line.productId) {
            return cur;
          }
          if (
            cur.line.productId === best.line.productId &&
            cur.lineIndex < best.lineIndex
          ) {
            return cur;
          }
        }
        return best;
      });
    const discount = Math.max(
      0,
      Math.min(chosen.line.unitPriceMinorUnits, eligibleGross, gross),
    );
    return {
      ok: true,
      discountMinorUnits: discount,
      freeItem: {
        productId: chosen.line.productId,
        productName: chosen.line.productName,
        lineIndex: chosen.lineIndex,
      },
      discountEligibleProductIds: null,
    };
  }

  let raw: number;
  if (config.discountType === "PERCENTAGE_OFF") {
    const pct = Math.max(0, Math.min(100, Math.floor(config.discountValue)));
    // Deterministic half-up rounding on the eligible merchandise.
    raw = Math.round((eligibleGross * pct) / 100);
    if (config.maxDiscountMinorUnits !== null) {
      raw = Math.min(raw, Math.max(0, Math.floor(config.maxDiscountMinorUnits)));
    }
  } else {
    // FIXED_AMOUNT
    raw = Math.max(0, Math.floor(config.discountValue));
  }

  // Never below $0, never more than the eligible merchandise (and never
  // more than the whole cart — a defensive belt on top of that).
  const discount = Math.max(0, Math.min(raw, eligibleGross, gross));
  return {
    ok: true,
    discountMinorUnits: discount,
    freeItem: null,
    discountEligibleProductIds,
  };
}

// --- Bonus Mocha Beans Promotions (Milestone 7D) ------------------
// Pure, framework-agnostic computation of the ADDITIONAL Mocha Beans one or
// more HQ bonus promotions award on a qualifying order. Never touches a
// database and never changes the standard order-level EARN — the caller
// still earns standard Beans on the post-discount merchandise subtotal
// exactly as before; this returns only the BONUS_EARN contribution.
//
// Deliberately simple (Milestone 7D is not a rules engine):
//   - Promotions target specific PRODUCTS only.
//   - The caller pre-filters `promotions` to those that are active, inside
//     their date window, and eligible for the order's location, and sorts
//     them by a stable order (creation time, then id) so ties resolve
//     deterministically.
//   - EXTRA_BEANS: `bonusValue` whole Beans per qualifying PAID unit.
//   - MULTIPLIER: the item's total earning becomes `bonusValue`x its
//     standard earning, so the bonus contribution is
//     `standardItemBeans * (bonusValue - 1)`.
//   - At most ONE promotion applies per qualifying item — the one producing
//     the highest Bean benefit for that item (first in the sorted list on a
//     tie). Bonuses never stack on the same item.
//
// Post-discount qualifying spend (Milestone 7C / 7E interaction):
//   - A unit made free by a FREE_ITEM reward OR a FREE_ITEM regular
//     Promotion/Coupon is NOT a paid qualifying unit — it earns neither
//     EXTRA_BEANS nor a spend-based multiplier bonus. The exact freed
//     priced lines are passed in `freeUnitLineIndices` (an index may repeat
//     when a reward and a promotion each freed a unit of that line).
//   - Every non-free monetary discount is a bucket in `orderLevelDiscounts`
//     with the products it applied to. Each bucket is allocated
//     proportionally (integer minor units, largest remainder first) ONLY
//     across the paid lines it actually touched — a FIXED_AMOUNT reward and
//     an ENTIRE_ORDER Promotion/Coupon spread over every line, but a
//     SELECTED_PRODUCTS / SELECTED_CATEGORIES Promotion/Coupon spreads only
//     over its eligible products, so a multiplier bonus on an UNRELATED
//     product is never computed on a reduced spend.
//
// All money is integer minor units. `unitPriceMinorUnits` is the fully
// resolved per-unit price INCLUDING modifier adjustments, exactly as
// priceCart produces it.

export type LoyaltyBonusPromotionKind = "EXTRA_BEANS" | "MULTIPLIER";

export interface BonusPromotionInput {
  id: string;
  name: string;
  type: LoyaltyBonusPromotionKind;
  // EXTRA_BEANS: whole Beans per qualifying paid unit. MULTIPLIER: the whole
  // multiple of standard item earning (>= 2).
  bonusValue: number;
  eligibleProductIds: string[];
}

export interface BonusCartLine {
  productId: string;
  productName: string;
  unitPriceMinorUnits: number;
  quantity: number;
}

// A non-free monetary discount to attribute across the paid merchandise for
// item-level qualifying-spend purposes (Milestone 7E). Each bucket is
// allocated proportionally ONLY across the paid lines it actually applied
// to: `eligibleProductIds: null` = whole order (a FIXED_AMOUNT reward, or an
// ENTIRE_ORDER Promotion/Coupon); a concrete set = only those products'
// lines (a SELECTED_PRODUCTS / SELECTED_CATEGORIES Promotion/Coupon).
export interface OrderLevelDiscountBucket {
  amountMinorUnits: number;
  eligibleProductIds: string[] | null;
}

export interface OrderBonusInput {
  lines: BonusCartLine[];
  // The current company-wide standard earning rate (Milestone 7B).
  standardRatePerDollar: number;
  // The 0-based indices of the priced lines that had a unit made free by a
  // FREE_ITEM loyalty reward (Milestone 7C) and/or a FREE_ITEM regular
  // Promotion/Coupon (Milestone 7E). One unit per entry is excluded from the
  // paid qualifying units; the same index may appear twice (both a reward
  // and a promotion freed a unit of that exact line).
  freeUnitLineIndices: number[];
  // Every non-free monetary discount, each with the products it applied to.
  orderLevelDiscounts: OrderLevelDiscountBucket[];
  // Pre-filtered (active + in window + location-eligible) and pre-sorted
  // (stable creation order) by the caller.
  promotions: BonusPromotionInput[];
}

export interface OrderBonusItemResult {
  sourcePromotionId: string;
  promotionName: string;
  promotionType: LoyaltyBonusPromotionKind;
  bonusValue: number;
  productId: string;
  productName: string;
  qualifyingUnits: number;
  qualifyingSpendMinorUnits: number;
  standardBeansForItem: number;
  bonusBeans: number;
}

export interface OrderBonusResult {
  totalBonusBeans: number;
  items: OrderBonusItemResult[];
}

export function computeOrderLoyaltyBonuses(
  input: OrderBonusInput,
): OrderBonusResult {
  const rate = input.standardRatePerDollar;

  // Paid units per line — a unit made free by a FREE_ITEM reward or a
  // FREE_ITEM regular Promotion/Coupon is not paid. Indexed by the exact
  // priced line; the same index may appear twice (a reward and a promotion
  // each freed a unit of that line).
  const freeUnitsByLine: number[] = input.lines.map(() => 0);
  for (const idx of input.freeUnitLineIndices) {
    if (Number.isInteger(idx) && idx >= 0 && idx < freeUnitsByLine.length) {
      freeUnitsByLine[idx] += 1;
    }
  }
  const paidUnits = input.lines.map((line, i) =>
    Math.max(0, Math.max(0, Math.floor(line.quantity)) - freeUnitsByLine[i]),
  );

  const paidGross = input.lines.map(
    (line, i) => Math.max(0, line.unitPriceMinorUnits) * paidUnits[i],
  );

  // Attribute every non-free monetary discount, each ONLY across the paid
  // merchandise it actually applied to (largest-remainder method,
  // deterministic tie-break on line index). Buckets are applied in order
  // and each line's REMAINING value depletes as buckets are attributed, so
  // no line is ever attributed more than its paid value and the sum of
  // attributed discounts equals the sum of the bucket amounts (capped at
  // the merchandise they could reach). A targeted Promotion/Coupon
  // therefore never reduces the qualifying spend of an unrelated product.
  const remaining = [...paidGross];
  for (const bucket of input.orderLevelDiscounts) {
    const weights = input.lines.map((line, i) =>
      bucket.eligibleProductIds === null ||
      bucket.eligibleProductIds.includes(line.productId)
        ? remaining[i]
        : 0,
    );
    const bucketWeightTotal = weights.reduce((s, w) => s + w, 0);
    const amount = Math.max(
      0,
      Math.min(Math.floor(bucket.amountMinorUnits) || 0, bucketWeightTotal),
    );
    const allocated = allocateProportionally(weights, amount);
    for (let i = 0; i < allocated.length; i++) {
      remaining[i] = Math.max(0, remaining[i] - allocated[i]);
    }
  }

  const qualifyingSpend = remaining;

  const items: OrderBonusItemResult[] = [];
  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i];
    const units = paidUnits[i];
    if (units <= 0) {
      continue; // no paid qualifying unit on this line
    }

    const standardBeansForItem = mochaBeansForQualifyingSpend(
      qualifyingSpend[i],
      rate,
    );

    let best: OrderBonusItemResult | null = null;
    for (const promotion of input.promotions) {
      if (!promotion.eligibleProductIds.includes(line.productId)) {
        continue;
      }

      let bonusBeans: number;
      if (promotion.type === "EXTRA_BEANS") {
        bonusBeans = Math.max(0, Math.floor(promotion.bonusValue)) * units;
      } else {
        const multiplier = Math.max(0, Math.floor(promotion.bonusValue));
        bonusBeans =
          multiplier >= 2 ? standardBeansForItem * (multiplier - 1) : 0;
      }

      if (bonusBeans <= 0) {
        continue;
      }
      // First promotion in the caller's stable order wins a tie.
      if (best === null || bonusBeans > best.bonusBeans) {
        best = {
          sourcePromotionId: promotion.id,
          promotionName: promotion.name,
          promotionType: promotion.type,
          bonusValue: promotion.bonusValue,
          productId: line.productId,
          productName: line.productName,
          qualifyingUnits: units,
          qualifyingSpendMinorUnits: qualifyingSpend[i],
          standardBeansForItem,
          bonusBeans,
        };
      }
    }

    if (best !== null) {
      items.push(best);
    }
  }

  return {
    totalBonusBeans: items.reduce((sum, item) => sum + item.bonusBeans, 0),
    items,
  };
}

// Split `total` across `weights` in integer minor units, proportionally to
// each weight, giving the leftover unit(s) to the largest fractional parts
// (ties broken by lowest index). The returned array sums exactly to `total`
// (assuming total <= sum(weights)) and never exceeds a weight.
function allocateProportionally(weights: number[], total: number): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (sum <= 0 || total <= 0) {
    return weights.map(() => 0);
  }
  const exact = weights.map((w) => (total * w) / sum);
  const base = exact.map((n) => Math.floor(n));
  let remaining = total - base.reduce((s, n) => s + n, 0);
  const order = exact
    .map((n, i) => ({ i, frac: n - Math.floor(n) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remaining <= 0) {
      break;
    }
    if (base[i] < weights[i]) {
      base[i] += 1;
      remaining -= 1;
    }
  }
  return base;
}
