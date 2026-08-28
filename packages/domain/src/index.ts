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
