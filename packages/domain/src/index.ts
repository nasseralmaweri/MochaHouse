import type {
  CheckoutLineInput,
  LocationMenuResponse,
  OrderLineSummary,
  OrderStatus,
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
