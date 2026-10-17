import type { OwnerOnboardingPlanOption } from "@mocha-house/contracts";
import { TOO_MANY_ATTEMPTS_MESSAGE } from "@/lib/rate-limit-message";
import {
  createBusinessError,
  formatPlanPrice,
  parsePriceChoice,
  priceChoiceValue,
  tokenLifetimeSeconds,
} from "./onboarding-state";

// SC4b — the business creation form: the posted choice carries exactly the
// price shown, errors map to plain messages, and the session cookie is sized
// from the token itself.
const plan: OwnerOnboardingPlanOption = {
  planId: "p1",
  planVersionId: "v2",
  name: "Growth",
  description: null,
  modules: ["core", "loyalty"],
  prices: [
    { planPriceId: "m1", interval: "MONTH", currency: "USD", amountMinorUnits: 4900 },
    { planPriceId: "y1", interval: "YEAR", currency: "USD", amountMinorUnits: 49000 },
  ],
};

describe("owner onboarding form", () => {
  it("round-trips the exact plan version and price shown", () => {
    const value = priceChoiceValue(plan, plan.prices[1]);
    expect(parsePriceChoice(value)).toEqual({
      planVersionId: "v2",
      planPriceId: "y1",
      expectedPrice: { interval: "YEAR", currency: "USD", amountMinorUnits: 49000 },
    });
  });

  it("refuses a malformed choice", () => {
    for (const value of [
      "",
      "v2:m1",
      "v2:m1:WEEK:USD:4900",
      "v2:m1:MONTH:usd:4900",
      "v2:m1:MONTH:USD:-1",
      "v2:m1:MONTH:USD:49.5",
      "v2:m1:MONTH:USD:4900:extra",
    ]) {
      expect(parsePriceChoice(value)).toBeNull();
    }
  });

  it("formats a price for the owner", () => {
    expect(formatPlanPrice(plan.prices[0])).toBe("$49.00 / month");
    expect(formatPlanPrice(plan.prices[1])).toBe("$490.00 / year");
  });

  it("maps failures to plain messages, keeping the API's own 400/409 text", () => {
    expect(createBusinessError(null)).toMatch(/Could not reach the server/);
    expect(createBusinessError({ status: 429, message: null })).toBe(TOO_MANY_ATTEMPTS_MESSAGE);
    expect(
      createBusinessError({ status: 409, message: "That price has changed. Review the plans and choose again." }),
    ).toBe("That price has changed. Review the plans and choose again.");
    expect(createBusinessError({ status: 403, message: "x" })).toMatch(/Sign in again/);
    expect(createBusinessError({ status: 500, message: "internal" })).toMatch(/isn't available/);
  });

  it("sizes the session from the token's own expiry (never more than 12 hours)", () => {
    const token = (exp: unknown) =>
      `h.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.s`;
    const now = 1_700_000_000_000;
    expect(tokenLifetimeSeconds(token(now / 1000 + 3600), now)).toBe(3600);
    expect(tokenLifetimeSeconds(token(now / 1000 + 86400), now)).toBe(12 * 3600);
    expect(tokenLifetimeSeconds(token(now / 1000 - 5), now)).toBe(0);
    expect(tokenLifetimeSeconds(token("soon"), now)).toBe(0);
    expect(tokenLifetimeSeconds("not-a-jwt", now)).toBe(0);
  });
});
