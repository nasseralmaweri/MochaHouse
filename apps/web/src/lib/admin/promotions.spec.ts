import {
  prepareCreatePromotion,
  prepareUpdatePromotion,
  type PromotionFormValues,
} from "./promotions";

function values(over: Partial<PromotionFormValues> = {}): PromotionFormValues {
  return {
    name: "Spring sale",
    description: "",
    kind: "AUTOMATIC",
    code: "",
    discountType: "PERCENTAGE_OFF",
    percentageValue: "20",
    fixedAmountDollars: "",
    maxDiscountDollars: "",
    applicability: "ENTIRE_ORDER",
    eligibleProductIds: [],
    eligibleCategoryIds: [],
    minimumDollars: "",
    appliesToAllLocations: true,
    eligibleLocationIds: [],
    startsAt: "",
    endsAt: "",
    totalRedemptionLimit: "",
    perCustomerRedemptionLimit: "",
    ...over,
  };
}

describe("prepareCreatePromotion", () => {
  it("builds an automatic percentage promotion", () => {
    const result = prepareCreatePromotion(values({ name: "  Spring  " }));
    expect(result).toEqual({
      ok: true,
      value: {
        name: "Spring",
        description: null,
        kind: "AUTOMATIC",
        code: null,
        discountType: "PERCENTAGE_OFF",
        discountValue: 20,
        maxDiscountMinorUnits: null,
        applicability: "ENTIRE_ORDER",
        eligibleProductIds: [],
        eligibleCategoryIds: [],
        minimumSubtotalMinorUnits: null,
        appliesToAllLocations: true,
        eligibleLocationIds: [],
        startsAt: null,
        endsAt: null,
        totalRedemptionLimit: null,
        perCustomerRedemptionLimit: null,
      },
    });
  });

  it("normalizes a coupon code and requires one for a COUPON", () => {
    const ok = prepareCreatePromotion(
      values({ kind: "COUPON", code: "welcome10" }),
    );
    expect(ok.ok && ok.value.code).toBe("WELCOME10");
    expect(prepareCreatePromotion(values({ kind: "COUPON", code: "" })).ok).toBe(
      false,
    );
    expect(
      prepareCreatePromotion(values({ kind: "COUPON", code: "ab" })).ok,
    ).toBe(false);
  });

  it("rejects a code on an automatic promotion", () => {
    expect(
      prepareCreatePromotion(values({ kind: "AUTOMATIC", code: "NOPE10" })).ok,
    ).toBe(false);
  });

  it.each(["0", "101", "1.5", ""])("rejects percentage %p", (raw) => {
    expect(
      prepareCreatePromotion(values({ percentageValue: raw })).ok,
    ).toBe(false);
  });

  it("parses a fixed amount to integer cents", () => {
    const result = prepareCreatePromotion(
      values({ discountType: "FIXED_AMOUNT", fixedAmountDollars: "5.00" }),
    );
    expect(result.ok && result.value.discountValue).toBe(500);
  });

  it("parses the percentage max discount to cents", () => {
    const result = prepareCreatePromotion(
      values({ maxDiscountDollars: "5.00" }),
    );
    expect(result.ok && result.value.maxDiscountMinorUnits).toBe(500);
  });

  it("requires product/category targeting for FREE_ITEM", () => {
    expect(
      prepareCreatePromotion(
        values({ discountType: "FREE_ITEM", applicability: "ENTIRE_ORDER" }),
      ).ok,
    ).toBe(false);
    const ok = prepareCreatePromotion(
      values({
        discountType: "FREE_ITEM",
        applicability: "SELECTED_PRODUCTS",
        eligibleProductIds: ["p1"],
      }),
    );
    expect(ok.ok && ok.value.eligibleProductIds).toEqual(["p1"]);
  });

  it("requires a selected location when not all-locations", () => {
    expect(
      prepareCreatePromotion(
        values({ appliesToAllLocations: false, eligibleLocationIds: [] }),
      ).ok,
    ).toBe(false);
  });

  it("rejects an end date not after the start date", () => {
    expect(
      prepareCreatePromotion(
        values({ startsAt: "2026-10-01T10:00", endsAt: "2026-09-01T10:00" }),
      ).ok,
    ).toBe(false);
  });

  it("parses redemption limits", () => {
    const result = prepareCreatePromotion(
      values({ totalRedemptionLimit: "500", perCustomerRedemptionLimit: "1" }),
    );
    expect(result.ok && result.value.totalRedemptionLimit).toBe(500);
    expect(result.ok && result.value.perCustomerRedemptionLimit).toBe(1);
  });
});

describe("prepareUpdatePromotion", () => {
  it("omits kind and discountType", () => {
    const result = prepareUpdatePromotion(values());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("kind" in result.value).toBe(false);
      expect("discountType" in result.value).toBe(false);
    }
  });
});
