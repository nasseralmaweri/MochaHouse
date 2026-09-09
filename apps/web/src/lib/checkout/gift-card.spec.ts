import {
  maskedGiftCardLabel,
  normalizeGiftCardCodeInput,
} from "./gift-card";

// Milestone 7G — the checkout gift-card field helpers. Pure logic; the
// server re-canonicalizes and hashes authoritatively.
describe("checkout gift-card helpers", () => {
  describe("normalizeGiftCardCodeInput", () => {
    it("trims and upper-cases", () => {
      expect(normalizeGiftCardCodeInput("  abcd 1234  ")).toBe("ABCD 1234");
    });

    it("returns null for an empty / whitespace-only field", () => {
      expect(normalizeGiftCardCodeInput("")).toBeNull();
      expect(normalizeGiftCardCodeInput("   ")).toBeNull();
    });
  });

  describe("maskedGiftCardLabel", () => {
    it("shows only the last four", () => {
      expect(maskedGiftCardLabel("4821")).toBe("Gift Card •••• 4821");
    });
  });
});
