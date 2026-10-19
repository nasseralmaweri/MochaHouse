import { PAYMENT_ACCOUNT_STATES } from "@mocha-house/contracts";
import {
  PAYMENT_ACCOUNT_LABELS,
  PAYMENTS_MESSAGES,
  canContinueSetup,
  connectReturn,
  isAllowedOnboardingUrl,
  paymentAccountDescription,
  paymentsRefusalMessage,
} from "./payments";
import { adminNavItems, groupAdminNavItems } from "./nav";

// ESP-04 M1 — Admin > Payments helpers: only Stripe's hosted onboarding is a
// redirect target, a return from Stripe is never trusted as status, and the
// Payments page appears only for the payments.connect holder (the owner).
describe("Admin > Payments", () => {
  it("labels and describes every account state", () => {
    for (const state of PAYMENT_ACCOUNT_STATES) {
      expect(PAYMENT_ACCOUNT_LABELS[state]).toBeTruthy();
      expect(paymentAccountDescription(state, 2)).toBeTruthy();
    }
    expect(paymentAccountDescription("SETUP_IN_PROGRESS", 1)).toContain(
      "one item",
    );
    expect(paymentAccountDescription("SETUP_IN_PROGRESS", 3)).toContain(
      "3 items",
    );
    expect(paymentAccountDescription("READY", 0)).toContain(
      "not switched on yet",
    );
  });

  it("offers setup only while there is setup to do", () => {
    expect(canContinueSetup("NOT_CONNECTED")).toBe(true);
    expect(canContinueSetup("SETUP_IN_PROGRESS")).toBe(true);
    expect(canContinueSetup("ACTION_REQUIRED")).toBe(true);
    for (const state of [
      "UNDER_REVIEW",
      "READY",
      "NOT_SUPPORTED",
      "CLOSED",
      "CONFIGURATION_MISMATCH",
    ] as const) {
      expect(canContinueSetup(state)).toBe(false);
    }
  });

  it("recognises only the two return markers", () => {
    expect(connectReturn("return")).toBe("return");
    expect(connectReturn("refresh")).toBe("refresh");
    expect(connectReturn("success")).toBeNull();
    expect(connectReturn(undefined)).toBeNull();
  });

  it("redirects only to Stripe's hosted onboarding (or the fake in development and tests)", () => {
    expect(
      isAllowedOnboardingUrl("https://connect.stripe.com/setup/e/acct_1/abc"),
    ).toBe(true);
    expect(
      isAllowedOnboardingUrl("https://connect.fake.test/onboarding/acct_x", {
        NODE_ENV: "development",
      }),
    ).toBe(true);
    expect(
      isAllowedOnboardingUrl("https://connect.fake.test/onboarding/acct_x", {}),
    ).toBe(false);
    for (const bad of [
      "https://connect.fake.test/onboarding/acct_x",
      "http://connect.stripe.com/setup",
      "https://connect.stripe.com.evil.example/setup",
      "https://user:pass@connect.stripe.com/setup",
      "https://checkout.stripe.com/c/pay",
      "javascript:alert(1)",
      42,
      null,
    ]) {
      expect(isAllowedOnboardingUrl(bad, { NODE_ENV: "production" })).toBe(
        false,
      );
    }
  });

  it("explains refusals without exposing details", () => {
    expect(
      paymentsRefusalMessage(403, { code: "PAYMENT_ACCOUNT_OWNER_ONLY" }),
    ).toBe(PAYMENTS_MESSAGES.ownerOnly);
    expect(paymentsRefusalMessage(503, null)).toBe(
      PAYMENTS_MESSAGES.unavailable,
    );
    expect(
      paymentsRefusalMessage(409, { code: "PAYMENT_ACCOUNT_NEEDS_SUPPORT" }),
    ).toBe(PAYMENTS_MESSAGES.needsSupport);
    expect(paymentsRefusalMessage(500, { message: "stack trace" })).toBe(
      PAYMENTS_MESSAGES.failed,
    );
  });

  it("shows Payments only to the payments.connect holder, next to Billing", () => {
    const owner = adminNavItems({
      "billing.view": { corporate: true, locationIds: [] },
      "payments.connect": { corporate: true, locationIds: [] },
    });
    expect(owner.map((i) => i.key)).toContain("payments");
    const footer = groupAdminNavItems(owner).find((g) => g.key === "admin");
    expect(footer?.items.map((i) => i.key)).toEqual(["billing", "payments"]);
    expect(
      adminNavItems({
        "billing.view": { corporate: true, locationIds: [] },
      }).map((i) => i.key),
    ).not.toContain("payments");
  });
});
