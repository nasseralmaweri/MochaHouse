import type { AdminLocationMenuProduct } from "@mocha-house/contracts";
import {
  orderabilityNote,
  usesLocationAvailability,
  usesLocationPrice,
  usingStandardPriceLeavesNoPrice,
} from "./location-menu";

const base: AdminLocationMenuProduct = {
  productId: "p1",
  productName: "Drip Coffee",
  productIsActive: true,
  categoryName: "Coffee",
  currency: "USD",
  shownOnMenu: true,
  standardPrice: 350,
  locationPrice: null,
  resultingPrice: 350,
  locationAvailability: null,
  resultingAvailability: true,
};

const p = (over: Partial<AdminLocationMenuProduct>): AdminLocationMenuProduct => ({
  ...base,
  ...over,
});

describe("usesLocationPrice / usesLocationAvailability", () => {
  it("are false when the location uses the standard settings", () => {
    expect(usesLocationPrice(base)).toBe(false);
    expect(usesLocationAvailability(base)).toBe(false);
  });

  it("are true when a location-specific value is set", () => {
    expect(usesLocationPrice(p({ locationPrice: 395 }))).toBe(true);
    expect(usesLocationAvailability(p({ locationAvailability: false }))).toBe(
      true,
    );
    expect(usesLocationAvailability(p({ locationAvailability: true }))).toBe(
      true,
    );
  });
});

describe("usingStandardPriceLeavesNoPrice", () => {
  it("is true only when there is a location price and no standard price", () => {
    expect(
      usingStandardPriceLeavesNoPrice(
        p({ standardPrice: null, locationPrice: 395, resultingPrice: 395 }),
      ),
    ).toBe(true);
  });

  it("is false when a standard price exists to fall back on", () => {
    expect(
      usingStandardPriceLeavesNoPrice(
        p({ standardPrice: 350, locationPrice: 395, resultingPrice: 395 }),
      ),
    ).toBe(false);
  });

  it("is false when there is no location price to remove", () => {
    expect(usingStandardPriceLeavesNoPrice(p({ standardPrice: null }))).toBe(
      false,
    );
  });
});

describe("orderabilityNote", () => {
  it("returns null when the item is orderable", () => {
    expect(orderabilityNote(base)).toBeNull();
  });

  it("flags an inactive product first", () => {
    expect(
      orderabilityNote(p({ productIsActive: false, shownOnMenu: true })),
    ).toContain("inactive");
  });

  it("flags a product hidden from the menu", () => {
    expect(orderabilityNote(p({ shownOnMenu: false }))).toContain("hidden");
  });

  it("flags a missing price", () => {
    expect(
      orderabilityNote(
        p({ standardPrice: null, locationPrice: null, resultingPrice: null }),
      ),
    ).toContain("needs a price");
  });

  it("flags a product marked unavailable here", () => {
    expect(
      orderabilityNote(
        p({ locationAvailability: false, resultingAvailability: false }),
      ),
    ).toContain("unavailable");
  });
});
