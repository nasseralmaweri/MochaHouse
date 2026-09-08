import {
  bonusValueLabel,
  isoToDatetimeLocal,
  prepareCreateBonusPromotion,
  prepareUpdateBonusPromotion,
  type BonusPromotionFormValues,
} from "./loyalty-bonus-promotions";

function values(
  over: Partial<BonusPromotionFormValues> = {},
): BonusPromotionFormValues {
  return {
    name: "Mango Matcha bonus",
    type: "EXTRA_BEANS",
    bonusValue: "20",
    eligibleProductIds: ["p1"],
    appliesToAllLocations: true,
    eligibleLocationIds: [],
    startsAt: "",
    endsAt: "",
    ...over,
  };
}

describe("prepareCreateBonusPromotion", () => {
  it("builds an all-locations EXTRA_BEANS request", () => {
    const result = prepareCreateBonusPromotion(values({ name: "  Bonus  " }));
    expect(result).toEqual({
      ok: true,
      value: {
        name: "Bonus",
        type: "EXTRA_BEANS",
        bonusValue: 20,
        eligibleProductIds: ["p1"],
        appliesToAllLocations: true,
        eligibleLocationIds: [],
        startsAt: null,
        endsAt: null,
      },
    });
  });

  it("carries selected locations when not all-locations", () => {
    const result = prepareCreateBonusPromotion(
      values({
        appliesToAllLocations: false,
        eligibleLocationIds: ["l1", "l1", "l2"],
      }),
    );
    expect(result.ok && result.value.eligibleLocationIds).toEqual(["l1", "l2"]);
  });

  it.each(["0", "100001", "1.5", "", "-4"])(
    "rejects EXTRA_BEANS value %p",
    (raw) => {
      expect(prepareCreateBonusPromotion(values({ bonusValue: raw })).ok).toBe(
        false,
      );
    },
  );

  it.each(["1", "11", "0"])("rejects MULTIPLIER value %p", (raw) => {
    expect(
      prepareCreateBonusPromotion(
        values({ type: "MULTIPLIER", bonusValue: raw }),
      ).ok,
    ).toBe(false);
  });

  it("accepts a MULTIPLIER between 2 and 10", () => {
    const result = prepareCreateBonusPromotion(
      values({ type: "MULTIPLIER", bonusValue: "3" }),
    );
    expect(result.ok && result.value.bonusValue).toBe(3);
  });

  it("requires at least one product", () => {
    expect(
      prepareCreateBonusPromotion(values({ eligibleProductIds: [] })).ok,
    ).toBe(false);
  });

  it("requires a location when not all-locations", () => {
    expect(
      prepareCreateBonusPromotion(
        values({ appliesToAllLocations: false, eligibleLocationIds: [] }),
      ).ok,
    ).toBe(false);
  });

  it("rejects an end date that is not after the start", () => {
    const result = prepareCreateBonusPromotion(
      values({ startsAt: "2026-10-01T10:00", endsAt: "2026-09-01T10:00" }),
    );
    expect(result.ok).toBe(false);
  });

  it("converts datetime-local values to absolute ISO strings", () => {
    const result = prepareCreateBonusPromotion(
      values({ startsAt: "2026-09-01T10:00", endsAt: "2026-10-01T10:00" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.startsAt).toMatch(/^2026-09-01T/);
      expect(new Date(result.value.endsAt!).getTime()).toBeGreaterThan(
        new Date(result.value.startsAt!).getTime(),
      );
    }
  });
});

describe("prepareUpdateBonusPromotion", () => {
  it("omits type and never carries isActive", () => {
    const result = prepareUpdateBonusPromotion(values());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect("type" in result.value).toBe(false);
      expect("isActive" in result.value).toBe(false);
      expect(result.value.name).toBe("Mango Matcha bonus");
    }
  });
});

describe("bonusValueLabel", () => {
  it("describes each bonus type", () => {
    expect(bonusValueLabel("EXTRA_BEANS", 20)).toBe("+20 Bonus Beans");
    expect(bonusValueLabel("MULTIPLIER", 2)).toBe("2× Mocha Beans");
  });
});

describe("isoToDatetimeLocal", () => {
  it("returns an empty string for null", () => {
    expect(isoToDatetimeLocal(null)).toBe("");
  });
  it("round-trips through the datetime-local form value", () => {
    const local = isoToDatetimeLocal(new Date("2026-09-01T10:30:00Z").toISOString());
    expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});
