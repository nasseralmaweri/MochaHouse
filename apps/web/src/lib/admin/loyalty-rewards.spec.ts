import {
  parseEarningRate,
  prepareCreateReward,
  prepareUpdateReward,
  rewardTypeLabel,
  REWARD_NAME_MAX_LENGTH,
  type RewardFormValues,
} from "./loyalty-rewards";

function values(over: Partial<RewardFormValues> = {}): RewardFormValues {
  return {
    name: "$5 Off",
    description: "",
    type: "FIXED_AMOUNT",
    beanCost: "100",
    fixedAmountDollars: "5.00",
    eligibleProductIds: [],
    eligibleCategoryIds: [],
    ...over,
  };
}

describe("parseEarningRate", () => {
  it("accepts whole 1-100", () => {
    expect(parseEarningRate("1")).toEqual({ ok: true, value: 1 });
    expect(parseEarningRate(" 3 ")).toEqual({ ok: true, value: 3 });
    expect(parseEarningRate("100")).toEqual({ ok: true, value: 100 });
  });
  it.each(["0", "101", "-1", "1.5", "", "two"])("rejects %p", (raw) => {
    expect(parseEarningRate(raw).ok).toBe(false);
  });
});

describe("prepareCreateReward — FIXED_AMOUNT", () => {
  it("builds a fixed dollar-off request in integer cents", () => {
    const result = prepareCreateReward(
      values({ name: "  $5 Off  ", fixedAmountDollars: "5.00", beanCost: "100" }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        name: "$5 Off",
        description: null,
        type: "FIXED_AMOUNT",
        beanCost: 100,
        fixedAmountMinorUnits: 500,
      },
    });
  });

  it("rejects a zero / malformed dollar amount", () => {
    expect(prepareCreateReward(values({ fixedAmountDollars: "0" })).ok).toBe(
      false,
    );
    expect(prepareCreateReward(values({ fixedAmountDollars: "abc" })).ok).toBe(
      false,
    );
    expect(
      prepareCreateReward(values({ fixedAmountDollars: "5.999" })).ok,
    ).toBe(false);
  });

  it("rejects a blank name and a non-positive bean cost", () => {
    expect(prepareCreateReward(values({ name: "   " })).ok).toBe(false);
    expect(prepareCreateReward(values({ beanCost: "0" })).ok).toBe(false);
    expect(prepareCreateReward(values({ beanCost: "-5" })).ok).toBe(false);
  });

  it("rejects an over-long name", () => {
    expect(
      prepareCreateReward(
        values({ name: "x".repeat(REWARD_NAME_MAX_LENGTH + 1) }),
      ).ok,
    ).toBe(false);
  });
});

describe("prepareCreateReward — FREE_ITEM", () => {
  it("requires at least one eligible product or category", () => {
    expect(
      prepareCreateReward(values({ type: "FREE_ITEM", fixedAmountDollars: "" }))
        .ok,
    ).toBe(false);
  });

  it("builds a free-item request with de-duplicated eligibility", () => {
    const result = prepareCreateReward(
      values({
        name: "Free Latte",
        type: "FREE_ITEM",
        beanCost: "150",
        fixedAmountDollars: "",
        eligibleProductIds: ["p1", "p1", "p2"],
        eligibleCategoryIds: ["c1"],
      }),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        name: "Free Latte",
        description: null,
        type: "FREE_ITEM",
        beanCost: 150,
        eligibleProductIds: ["p1", "p2"],
        eligibleCategoryIds: ["c1"],
      },
    });
  });
});

describe("prepareUpdateReward", () => {
  it("never sends a type field", () => {
    const result = prepareUpdateReward(values());
    expect(result.ok && "type" in result.value).toBe(false);
  });
});

describe("rewardTypeLabel", () => {
  it("maps enum to plain language", () => {
    expect(rewardTypeLabel("FIXED_AMOUNT")).toBe("Dollar off");
    expect(rewardTypeLabel("FREE_ITEM")).toBe("Free item");
  });
});
