import type { AdminLocationMenuProduct } from "@mocha-house/contracts";

// Plain-language helpers for the location menu / pricing screen (Milestone
// 5D-4). The screen never says "override" — a location either uses the
// standard setting or has its own.

export function usesLocationPrice(product: AdminLocationMenuProduct): boolean {
  return product.locationPrice !== null;
}

export function usesLocationAvailability(
  product: AdminLocationMenuProduct,
): boolean {
  return product.locationAvailability !== null;
}

// True when returning to the standard price would leave the product with no
// usable price at all (there is no standard price to fall back on). The UI
// warns before doing this, but still allows it — a null standard price is a
// deliberately supported state.
export function usingStandardPriceLeavesNoPrice(
  product: AdminLocationMenuProduct,
): boolean {
  return product.locationPrice !== null && product.standardPrice === null;
}

// The one short sentence explaining whether customers can order this item
// here right now, or null when everything is fine and no note is needed.
export function orderabilityNote(
  product: AdminLocationMenuProduct,
): string | null {
  if (!product.productIsActive) {
    return "This product is inactive, so customers never see it.";
  }
  if (!product.shownOnMenu) {
    return "This product is hidden from this menu.";
  }
  if (product.resultingPrice === null) {
    return "This item needs a price before it can be ordered at this location.";
  }
  if (!product.resultingAvailability) {
    return "This item is marked unavailable at this location.";
  }
  return null;
}
