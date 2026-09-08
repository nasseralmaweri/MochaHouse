import {
  correctionWouldBeOutOfRange,
  normalizeGiftCardQuery,
  prepareConfiguration,
  prepareCorrection,
  prepareIssue,
} from "./gift-cards";

// Milestone 7F — the HQ gift-card form helpers. Pure logic; the API
// re-validates everything.
describe("gift-card admin helpers", () => {
  describe("prepareIssue", () => {
    it("accepts a valid dollar amount and converts to minor units", () => {
      expect(prepareIssue("25")).toEqual({
        ok: true,
        value: { originalValueMinorUnits: 2500 },
      });
      expect(prepareIssue("$10.50")).toEqual({
        ok: true,
        value: { originalValueMinorUnits: 1050 },
      });
    });

    it("rejects zero, blank, non-money and over-ceiling amounts", () => {
      expect(prepareIssue("").ok).toBe(false);
      expect(prepareIssue("0").ok).toBe(false);
      expect(prepareIssue("abc").ok).toBe(false);
      expect(prepareIssue("2000.01").ok).toBe(false);
      expect(prepareIssue("2000").ok).toBe(true);
    });
  });

  describe("prepareCorrection", () => {
    const key = "op-key-12345678";

    it("builds a signed delta from direction + amount", () => {
      expect(
        prepareCorrection(
          { direction: "add", amount: "5", reason: "Goodwill" },
          key,
        ),
      ).toEqual({
        ok: true,
        value: { deltaMinorUnits: 500, reason: "Goodwill", operationKey: key },
      });
      expect(
        prepareCorrection(
          { direction: "deduct", amount: "5", reason: "Fix double issue" },
          key,
        ),
      ).toEqual({
        ok: true,
        value: {
          deltaMinorUnits: -500,
          reason: "Fix double issue",
          operationKey: key,
        },
      });
    });

    it("requires a non-empty reason and a positive amount", () => {
      expect(
        prepareCorrection(
          { direction: "add", amount: "5", reason: "   " },
          key,
        ).ok,
      ).toBe(false);
      expect(
        prepareCorrection(
          { direction: "add", amount: "0", reason: "x" },
          key,
        ).ok,
      ).toBe(false);
      expect(
        prepareCorrection(
          { direction: "add", amount: "9999", reason: "x" },
          key,
        ).ok,
      ).toBe(false);
    });
  });

  describe("correctionWouldBeOutOfRange", () => {
    it("flags below zero and above the ceiling", () => {
      expect(correctionWouldBeOutOfRange(1000, -1500)).toBe(true);
      expect(correctionWouldBeOutOfRange(199_000, 2000)).toBe(true);
      expect(correctionWouldBeOutOfRange(1000, 500)).toBe(false);
      expect(correctionWouldBeOutOfRange(1000, -1000)).toBe(false);
    });
  });

  describe("prepareConfiguration", () => {
    it("normalizes, sorts and de-duplicates preset amounts", () => {
      expect(
        prepareConfiguration({
          presetInputs: ["50", "10", "25", " "],
          customAmountEnabled: false,
        }),
      ).toEqual({
        ok: true,
        value: {
          presetAmountsMinorUnits: [1000, 2500, 5000],
          customAmountEnabled: false,
        },
      });
    });

    it("rejects empty, duplicate, invalid or over-ceiling entries", () => {
      expect(
        prepareConfiguration({ presetInputs: [], customAmountEnabled: true }).ok,
      ).toBe(false);
      expect(
        prepareConfiguration({
          presetInputs: ["10", "10"],
          customAmountEnabled: true,
        }).ok,
      ).toBe(false);
      expect(
        prepareConfiguration({
          presetInputs: ["10", "abc"],
          customAmountEnabled: true,
        }).ok,
      ).toBe(false);
      expect(
        prepareConfiguration({
          presetInputs: ["2500"],
          customAmountEnabled: true,
        }).ok,
      ).toBe(false);
    });
  });

  describe("normalizeGiftCardQuery", () => {
    it("trims", () => {
      expect(normalizeGiftCardQuery("  ABCD 1234  ")).toBe("ABCD 1234");
    });
  });
});
