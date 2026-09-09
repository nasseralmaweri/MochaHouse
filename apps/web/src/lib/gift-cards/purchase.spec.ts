import type { GiftCardPurchaseOptions } from "@mocha-house/contracts";
import {
  CODE_RETRIEVAL_NOTICE,
  formatMinorUnits,
  groupGiftCardCode,
  isPurchasableAmount,
  maskedGiftCardLabel,
  normalizeBalanceCode,
  parseCustomAmount,
} from "./purchase";

const OPTIONS: GiftCardPurchaseOptions = {
  presetAmountsMinorUnits: [1000, 2500, 5000, 10000],
  customAmountEnabled: true,
  customAmountMinMinorUnits: 500,
  customAmountMaxMinorUnits: 50_000,
  currency: "USD",
};

describe("parseCustomAmount", () => {
  it("parses whole and fractional dollar entries to integer minor units", () => {
    expect(parseCustomAmount("25", OPTIONS)).toEqual({ ok: true, minorUnits: 2500 });
    expect(parseCustomAmount("25.00", OPTIONS)).toEqual({ ok: true, minorUnits: 2500 });
    expect(parseCustomAmount("  $7.50 ", OPTIONS)).toEqual({ ok: true, minorUnits: 750 });
    expect(parseCustomAmount("5", OPTIONS)).toEqual({ ok: true, minorUnits: 500 });
    expect(parseCustomAmount("500", OPTIONS)).toEqual({ ok: true, minorUnits: 50_000 });
  });

  it("rejects an empty or malformed entry", () => {
    expect(parseCustomAmount("", OPTIONS).ok).toBe(false);
    expect(parseCustomAmount("abc", OPTIONS).ok).toBe(false);
    expect(parseCustomAmount("10.999", OPTIONS).ok).toBe(false);
    expect(parseCustomAmount("-10", OPTIONS).ok).toBe(false);
  });

  it("rejects an amount below the minimum or above the custom maximum", () => {
    expect(parseCustomAmount("4.99", OPTIONS)).toEqual({
      ok: false,
      error: "The lowest gift-card amount is $5.00.",
    });
    expect(parseCustomAmount("500.01", OPTIONS)).toEqual({
      ok: false,
      error: "The highest custom amount is $500.00.",
    });
  });
});

describe("isPurchasableAmount", () => {
  it("accepts an exact preset", () => {
    expect(isPurchasableAmount(2500, OPTIONS)).toBe(true);
  });

  it("accepts a custom amount within bounds when custom is enabled", () => {
    expect(isPurchasableAmount(1234, OPTIONS)).toBe(true);
    expect(isPurchasableAmount(500, OPTIONS)).toBe(true);
    expect(isPurchasableAmount(50_000, OPTIONS)).toBe(true);
  });

  it("rejects an out-of-bounds custom amount", () => {
    expect(isPurchasableAmount(499, OPTIONS)).toBe(false);
    expect(isPurchasableAmount(50_001, OPTIONS)).toBe(false);
  });

  it("accepts a preset that sits above the custom maximum", () => {
    const withBigPreset: GiftCardPurchaseOptions = {
      ...OPTIONS,
      presetAmountsMinorUnits: [2500, 120_000],
    };
    expect(isPurchasableAmount(120_000, withBigPreset)).toBe(true);
  });

  it("rejects any non-preset custom amount when custom is disabled", () => {
    const noCustom: GiftCardPurchaseOptions = {
      ...OPTIONS,
      customAmountEnabled: false,
    };
    expect(isPurchasableAmount(2500, noCustom)).toBe(true);
    expect(isPurchasableAmount(1234, noCustom)).toBe(false);
  });

  it("rejects non-integer and non-positive amounts", () => {
    expect(isPurchasableAmount(12.5, OPTIONS)).toBe(false);
    expect(isPurchasableAmount(0, OPTIONS)).toBe(false);
  });
});

describe("normalizeBalanceCode", () => {
  it("trims and upper-cases", () => {
    expect(normalizeBalanceCode("  abcd efgh 2345 6789 ")).toBe(
      "ABCD EFGH 2345 6789",
    );
  });

  it("returns null for an empty field", () => {
    expect(normalizeBalanceCode("   ")).toBeNull();
  });
});

describe("groupGiftCardCode", () => {
  it("regroups a compact or messy code into 4-character blocks", () => {
    expect(groupGiftCardCode("23456789ABCDEFGH")).toBe("2345 6789 ABCD EFGH");
    expect(groupGiftCardCode("2345-6789-abcd-efgh")).toBe("2345 6789 ABCD EFGH");
  });
});

describe("maskedGiftCardLabel / formatMinorUnits", () => {
  it("masks all but the last four", () => {
    expect(maskedGiftCardLabel("4821")).toBe("•••• •••• •••• 4821");
  });

  it("formats minor units as USD", () => {
    expect(formatMinorUnits(2500)).toBe("$25.00");
    expect(formatMinorUnits(500)).toBe("$5.00");
  });
});

it("ships a plain-language 7-day retrieval notice", () => {
  expect(CODE_RETRIEVAL_NOTICE).toMatch(/7 days/);
});
