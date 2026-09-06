import {
  prepareAdjustment,
  wouldGoNegative,
  normalizeLoyaltyQuery,
  ADJUSTMENT_REASON_MAX_LENGTH,
  type AdjustmentFormValues,
} from "./loyalty-adjustment";

const KEY = "00000000-0000-0000-0000-000000000000";

function values(over: Partial<AdjustmentFormValues> = {}): AdjustmentFormValues {
  return { direction: "add", amount: "10", reason: "Service recovery", ...over };
}

describe("prepareAdjustment", () => {
  it("builds a positive delta for an 'add'", () => {
    const result = prepareAdjustment(values({ direction: "add", amount: "25" }), KEY);
    expect(result).toEqual({
      ok: true,
      value: { deltaBeans: 25, reason: "Service recovery", operationKey: KEY },
    });
  });

  it("builds a negative delta for a 'deduct'", () => {
    const result = prepareAdjustment(
      values({ direction: "deduct", amount: "5" }),
      KEY,
    );
    expect(result).toEqual({
      ok: true,
      value: { deltaBeans: -5, reason: "Service recovery", operationKey: KEY },
    });
  });

  it("trims the reason", () => {
    const result = prepareAdjustment(values({ reason: "  goodwill  " }), KEY);
    expect(result.ok && result.value.reason).toBe("goodwill");
  });

  it("rejects a blank reason", () => {
    const result = prepareAdjustment(values({ reason: "   " }), KEY);
    expect(result).toEqual({ ok: false, error: "A reason is required." });
  });

  it("rejects an over-long reason", () => {
    const result = prepareAdjustment(
      values({ reason: "x".repeat(ADJUSTMENT_REASON_MAX_LENGTH + 1) }),
      KEY,
    );
    expect(result.ok).toBe(false);
  });

  it.each(["0", "-3", "2.5", "", "  ", "abc", "1e3"])(
    "rejects a non-whole-positive amount %p",
    (amount) => {
      expect(prepareAdjustment(values({ amount }), KEY).ok).toBe(false);
    },
  );
});

describe("wouldGoNegative", () => {
  it("is true only when the resulting balance is below zero", () => {
    expect(wouldGoNegative(10, -11)).toBe(true);
    expect(wouldGoNegative(10, -10)).toBe(false);
    expect(wouldGoNegative(0, 5)).toBe(false);
  });
});

describe("normalizeLoyaltyQuery", () => {
  it("trims", () => {
    expect(normalizeLoyaltyQuery("  a@b.com  ")).toBe("a@b.com");
    expect(normalizeLoyaltyQuery("   ")).toBe("");
  });
});
